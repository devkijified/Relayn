// =========================================================================
// RELAYN: Partition catalog (catalog-first listing source, TypeScript)
// -------------------------------------------------------------------------
// BASE: build stamp 202610281848 (local Grok edits on a03f83d).
//
// Catalog-first (doc 23) refines the whole-root auto-pull of doc 22, which
// is now the FALLBACK path. A Partition lists from the CATALOG ONLY: a
// standing, metadata-only inventory of a source machine's Partition roots.
// Listings are host-independent; CONTENT stays host-dependent until bytes
// are seeded and hash-verified.
//
// Three states, one vocabulary across Files and Partition (ruling UI):
//   available  bytes sealed AND hash-verified; host-independent content
//   seeding    catalog knows the file; Host awake; bytes in flight/queued
//   waiting    catalog knows the file; bytes absent; Host asleep/unscheduled
// No mechanism words (mock/mirror/staged/replica/torrent/seed) ever reach
// user-facing copy; this is server state, not UI copy.
//
// STORAGE (ruling: StateDocs, state-class, NEVER swept):
//   key  <account>/_partition/<machineId>/catalog.json
// isBulkKey() in storage.ts already excludes "/_partition/", so the sweep
// that expires bulk (move chunks, 14-day window) never touches the
// catalog or the mutate ledger. Catalog writes ride StateDocs.saveJSON,
// a single-object atomic write: a mutation is durable before the call
// returns, exactly like the ledger.
//
// RULING C (fingerprint): the catalog fingerprint is size + modTime. No
// full Host read happens at catalog time. The full SHA-256 is computed
// during seeding and VERIFIED before an entry may flip to `available`
// (applySeedResult below). RESIDUAL RISK, accepted and stated: a file
// changed in place to the exact same size AND modTime is not detected as
// content-stale by the fingerprint alone; that window is closed by the
// full hash at the next seed. Listing freshness favours cost here.
//
// RULING A (single listing source): a Partition surface lists from this
// catalog ONLY. The listing never merges a live Host browse with catalog
// rows. browse() here reads catalog entries exclusively and overlays the
// Partition mutate ledger (delete/rename) on top.
//
// RULING F (expiry vs ledger): when a bulk piece expires under the 14-day
// window, its catalog entry returns to `waiting` and the moveId detaches
// (expire()). The Partition mutate ledger stays AUTHORITATIVE over the
// catalog: a copy-side delete is applied as a view overlay in browse() so
// a re-seed never resurrects a deleted path, and a rename applies as a
// view rule over whatever the catalog says.
// =========================================================================

import type { StateDocs } from "./storage.js";
import type { PartitionMutateRecord } from "./partition-store.js";
import { PARTITION_SHELL_PREFIXES } from "./partition-store.js";

export type PartitionAvailability = "available" | "seeding" | "waiting";

export interface PartitionCatalogEntry {
  packPath: string; // inventory pack path (files/Desktop/..., etc.)
  size: number; // bytes (fingerprint half)
  modTime: number; // unix seconds (fingerprint half); 0 when unknown
  hash: string; // verified content sha256 when known; "" until a seed verifies
  hashAlg?: "sha256";
  availability: PartitionAvailability;
  lastUsedAt?: string; // RFC3339; drives the 14-day bulk window from real use
  moveId?: string; // set only when bytes live in a sealed move AND verified
  category: string; // files | appData | setup | browser | ...
  gap?: string; // named per-file failure; the rest of the catalog continues
}

export interface PartitionCatalogDocument {
  accountId: string;
  machineId: string;
  revisedAt: string; // RFC3339 of the last replace/merge/flip
  hostCatalogAt?: string; // when Host last returned a catalog revision
  entries: PartitionCatalogEntry[];
}

export interface PartitionCatalogChild {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
  modTime: number;
  category?: string;
  moveId?: string;
  availability?: PartitionAvailability; // files only; dirs omit it
  gap?: string;
}

function rfc3339Now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function categoryOf(packPath: string): string {
  const i = packPath.indexOf("/");
  return i < 0 ? packPath : packPath.slice(0, i);
}

function parentPrefix(packPath: string): string {
  const i = packPath.lastIndexOf("/");
  return i < 0 ? "" : packPath.slice(0, i);
}

/** True when a pack path sits under one of the shell-set prefixes. */
export function isShellPath(packPath: string): boolean {
  for (const pref of PARTITION_SHELL_PREFIXES) {
    if (packPath === pref || packPath.startsWith(pref + "/")) return true;
  }
  return false;
}

/**
 * The standing per-account, per-machine catalog. Source of truth for
 * Partition listings across Viewer restarts and multiple operators.
 * Entries persist as state-class; bulk expiry only detaches moveId and
 * drops availability to waiting, it never deletes the catalog entry.
 */
export class PartitionCatalog {
  // account|machineId -> loaded document (in-memory cache over StateDocs)
  private docsCache = new Map<string, PartitionCatalogDocument>();

  constructor(private readonly store: StateDocs) {}

  private cacheKey(account: string, machineId: string): string {
    return account + "|" + machineId;
  }

  private objectKey(account: string, machineId: string): string {
    // Under _partition/: isBulkKey() excludes it, so NEVER swept.
    return `${account}/_partition/${machineId}/catalog.json`;
  }

  /** Load (and cache) the catalog document; empty doc when absent. */
  async load(
    account: string,
    machineId: string
  ): Promise<PartitionCatalogDocument> {
    const ck = this.cacheKey(account, machineId);
    const cached = this.docsCache.get(ck);
    if (cached) return cached;
    const loaded = await this.store.loadJSON<PartitionCatalogDocument>(
      this.objectKey(account, machineId)
    );
    const doc: PartitionCatalogDocument =
      loaded && Array.isArray(loaded.entries)
        ? {
            accountId: account,
            machineId,
            revisedAt: loaded.revisedAt || rfc3339Now(),
            hostCatalogAt: loaded.hostCatalogAt,
            entries: loaded.entries.filter(
              (e) => e && typeof e === "object" && typeof e.packPath === "string"
            )
          }
        : { accountId: account, machineId, revisedAt: rfc3339Now(), entries: [] };
    this.docsCache.set(ck, doc);
    return doc;
  }

  private async save(doc: PartitionCatalogDocument): Promise<void> {
    doc.revisedAt = rfc3339Now();
    this.docsCache.set(this.cacheKey(doc.accountId, doc.machineId), doc);
    // Atomic single-object write-through (StateDocs contract).
    await this.store.saveJSON(this.objectKey(doc.accountId, doc.machineId), doc);
  }

  private entryMap(
    doc: PartitionCatalogDocument
  ): Map<string, PartitionCatalogEntry> {
    const m = new Map<string, PartitionCatalogEntry>();
    for (const e of doc.entries) m.set(e.packPath, e);
    return m;
  }

  private commit(
    doc: PartitionCatalogDocument,
    m: Map<string, PartitionCatalogEntry>
  ): Promise<void> {
    doc.entries = Array.from(m.values()).sort((a, b) =>
      a.packPath.localeCompare(b.packPath)
    );
    return this.save(doc);
  }

  /**
   * Merge a Host catalog revision (metadata only: path/size/modTime and
   * optional hash). Ruling C: fingerprint is size+modTime, no bytes.
   * - new path -> waiting (catalog knows it; no bytes yet)
   * - same fingerprint -> keep availability + moveId + verified hash
   * - changed fingerprint (size OR modTime differ) -> content-stale:
   *   availability drops to waiting, moveId detaches, verified hash clears
   * This is an UPSERT merge (paged-safe): entries not in this revision
   * are left as-is, never silently dropped.
   */
  async mergeHostCatalog(
    account: string,
    machineId: string,
    incoming: Array<{
      packPath: string;
      size: number;
      modTime: number;
      hash?: string;
      category?: string;
    }>
  ): Promise<PartitionCatalogDocument> {
    const doc = await this.load(account, machineId);
    const m = this.entryMap(doc);
    for (const row of incoming) {
      const packPath = String(row.packPath || "").replace(/^\/+|\/+$/g, "");
      if (!packPath || packPath.includes("..")) continue;
      const size = typeof row.size === "number" ? row.size : 0;
      const modTime = typeof row.modTime === "number" ? row.modTime : 0;
      const existing = m.get(packPath);
      if (!existing) {
        m.set(packPath, {
          packPath,
          size,
          modTime,
          hash: typeof row.hash === "string" ? row.hash : "",
          hashAlg: "sha256",
          availability: "waiting",
          category: row.category || categoryOf(packPath)
        });
        continue;
      }
      const sameFingerprint =
        existing.size === size && existing.modTime === modTime;
      if (sameFingerprint) {
        // Keep availability / moveId / verified hash as they are.
        if (row.hash && !existing.hash) existing.hash = row.hash;
        continue;
      }
      // Content-stale: the bytes we may hold no longer match the machine.
      existing.size = size;
      existing.modTime = modTime;
      existing.hash = "";
      existing.availability = "waiting";
      existing.moveId = undefined;
    }
    doc.hostCatalogAt = rfc3339Now();
    await this.commit(doc, m);
    return doc;
  }

  /**
   * Sealed-move rebuild CONFIRMS available rows into the catalog (ruling
   * A integration): a packPath whose sealed bytes already exist becomes
   * `available` with its moveId bound. If the fingerprint changed vs the
   * catalog, the sealed bytes are the freshest truth we have, so we adopt
   * them. Entries the catalog already knew as waiting flip to available.
   */
  async confirmAvailableFromRefs(
    account: string,
    machineId: string,
    refs: Array<{
      packPath: string;
      size: number;
      modTime: number;
      moveId: string;
      category?: string;
      sha256?: string;
    }>
  ): Promise<void> {
    const doc = await this.load(account, machineId);
    const m = this.entryMap(doc);
    for (const ref of refs) {
      const packPath = ref.packPath;
      if (!packPath || packPath.includes("..")) continue;
      const existing = m.get(packPath);
      if (existing) {
        existing.size = ref.size;
        existing.modTime = ref.modTime;
        existing.availability = "available";
        existing.moveId = ref.moveId;
        if (ref.sha256) existing.hash = ref.sha256;
        existing.category = ref.category || existing.category;
        existing.gap = undefined;
      } else {
        m.set(packPath, {
          packPath,
          size: ref.size,
          modTime: ref.modTime,
          hash: ref.sha256 || "",
          hashAlg: "sha256",
          availability: "available",
          moveId: ref.moveId,
          category: ref.category || categoryOf(packPath)
        });
      }
    }
    await this.commit(doc, m);
  }

  /** Host awake + a batch picked this path: mark it seeding. */
  async markSeeding(
    account: string,
    machineId: string,
    packPath: string
  ): Promise<PartitionCatalogEntry | undefined> {
    const doc = await this.load(account, machineId);
    const m = this.entryMap(doc);
    const e = m.get(packPath);
    if (!e || e.availability === "available") return e;
    e.availability = "seeding";
    await this.commit(doc, m);
    return e;
  }

  /**
   * RULING C hard gate: a piece may flip to `available` ONLY when a full
   * SHA-256 computed during seeding is present and (when the catalog
   * already holds a verified hash) matches it. Without a verified hash the
   * entry stays `seeding`. On success bind moveId, store the verified
   * hash, and stamp lastUsedAt (real use starts the 14-day window).
   * Returns true iff the entry became `available`.
   */
  async applySeedResult(
    account: string,
    machineId: string,
    packPath: string,
    result: { verifiedHash?: string; moveId?: string }
  ): Promise<boolean> {
    const doc = await this.load(account, machineId);
    const m = this.entryMap(doc);
    const e = m.get(packPath);
    if (!e) return false;
    const verified = (result.verifiedHash || "").trim();
    if (!verified) {
      // No hash verified yet: never available (ruling C).
      if (e.availability === "waiting") e.availability = "seeding";
      await this.commit(doc, m);
      return false;
    }
    if (e.hash && e.hash !== verified) {
      // Mismatch: bytes do not match the known content hash. Stay seeding,
      // name the gap, do NOT flip available.
      e.availability = "seeding";
      e.gap = "seeded bytes did not match the expected content hash; held back";
      await this.commit(doc, m);
      return false;
    }
    e.hash = verified;
    e.availability = "available";
    if (result.moveId) e.moveId = result.moveId;
    e.lastUsedAt = rfc3339Now();
    e.gap = undefined;
    await this.commit(doc, m);
    return true;
  }

  /**
   * RULING F: a bulk piece expired under the 14-day window. The catalog
   * entry survives (state-class) but returns to `waiting` and the moveId
   * detaches. Content must be re-seeded; the listing never disappears.
   */
  async expire(
    account: string,
    machineId: string,
    packPath: string
  ): Promise<boolean> {
    const doc = await this.load(account, machineId);
    const m = this.entryMap(doc);
    const e = m.get(packPath);
    if (!e) return false;
    e.availability = "waiting";
    e.moveId = undefined;
    await this.commit(doc, m);
    return true;
  }

  /** Mark real use (open or seed-for-use): refresh the 14-day window. */
  async touchUsed(
    account: string,
    machineId: string,
    packPath: string
  ): Promise<void> {
    const doc = await this.load(account, machineId);
    const m = this.entryMap(doc);
    const e = m.get(packPath);
    if (!e) return;
    e.lastUsedAt = rfc3339Now();
    await this.commit(doc, m);
  }

  async queryByPath(
    account: string,
    machineId: string,
    packPath: string
  ): Promise<PartitionCatalogEntry | undefined> {
    const doc = await this.load(account, machineId);
    return this.entryMap(doc).get(packPath);
  }

  /**
   * Apply the Partition mutate ledger (delete/rename) as a view overlay,
   * exactly the rule partition-store uses for its live map, so the ledger
   * stays AUTHORITATIVE over the catalog (ruling F). Returns a path-keyed
   * map of the surviving/renamed entries.
   */
  private applyLedger(
    entries: PartitionCatalogEntry[],
    ledger: PartitionMutateRecord[]
  ): Map<string, PartitionCatalogEntry> {
    const out = new Map<string, PartitionCatalogEntry>();
    for (const e of entries) out.set(e.packPath, e);
    for (const rec of ledger) {
      if (rec.op === "delete") {
        out.delete(rec.path);
        for (const p of Array.from(out.keys())) {
          if (p === rec.path || p.startsWith(rec.path + "/")) out.delete(p);
        }
      } else if (rec.op === "rename" && rec.newName) {
        const parent = parentPrefix(rec.path);
        const nextPath = parent ? parent + "/" + rec.newName : rec.newName;
        const old = out.get(rec.path);
        if (old) {
          out.delete(rec.path);
          out.set(nextPath, { ...old, packPath: nextPath });
        }
        const under = rec.path + "/";
        for (const [p, ref] of Array.from(out.entries())) {
          if (!p.startsWith(under)) continue;
          out.delete(p);
          const moved = nextPath + "/" + p.slice(under.length);
          out.set(moved, { ...ref, packPath: moved });
        }
      }
    }
    return out;
  }

  /** Catalog entries after the ledger overlay (ledger wins). */
  async liveEntries(
    account: string,
    machineId: string,
    ledger: PartitionMutateRecord[]
  ): Promise<PartitionCatalogEntry[]> {
    const doc = await this.load(account, machineId);
    return Array.from(this.applyLedger(doc.entries, ledger).values());
  }

  /**
   * RULING A: a Partition listing from the CATALOG ONLY, with availability
   * on every file row. Never merges any live Host browse. Directories are
   * synthesized from pack paths, same shape as partition-store.browse.
   */
  async browse(
    account: string,
    machineId: string,
    prefix: string,
    ledger: PartitionMutateRecord[],
    opts?: { offset?: number; limit?: number }
  ): Promise<{
    prefix: string;
    children: PartitionCatalogChild[];
    total: number;
    source: "catalog";
  }> {
    const live = this.applyLedger(
      (await this.load(account, machineId)).entries,
      ledger
    );
    const pfx = (prefix || "").replace(/^\/+|\/+$/g, "");
    const offset = Math.max(0, opts?.offset || 0);
    const limit = Math.min(500, Math.max(1, opts?.limit || 200));

    const dirs = new Map<string, PartitionCatalogChild>();
    const files: PartitionCatalogChild[] = [];

    for (const [packPath, e] of live) {
      if (pfx) {
        if (packPath !== pfx && !packPath.startsWith(pfx + "/")) continue;
        if (packPath === pfx) continue;
        const rest = packPath.slice(pfx.length + 1);
        const slash = rest.indexOf("/");
        if (slash >= 0) {
          const name = rest.slice(0, slash);
          const dirPath = pfx + "/" + name;
          if (!dirs.has(dirPath)) {
            dirs.set(dirPath, {
              name,
              path: dirPath,
              kind: "dir",
              size: 0,
              modTime: 0
            });
          }
        } else {
          files.push({
            name: rest,
            path: packPath,
            kind: "file",
            size: e.size,
            modTime: e.modTime,
            moveId: e.moveId,
            category: e.category,
            availability: e.availability,
            gap: e.gap
          });
        }
      } else {
        const slash = packPath.indexOf("/");
        const name = slash < 0 ? packPath : packPath.slice(0, slash);
        if (!dirs.has(name)) {
          dirs.set(name, {
            name,
            path: name,
            kind: "dir",
            size: 0,
            modTime: 0
          });
        }
      }
    }

    const children = [
      ...Array.from(dirs.values()).sort((a, b) => a.name.localeCompare(b.name)),
      ...files.sort((a, b) => a.name.localeCompare(b.name))
    ];
    return {
      prefix: pfx,
      children: children.slice(offset, offset + limit),
      total: children.length,
      source: "catalog"
    };
  }

  /** Counts by availability for a status surface (ledger overlaid). */
  async counts(
    account: string,
    machineId: string,
    ledger: PartitionMutateRecord[]
  ): Promise<{
    total: number;
    available: number;
    seeding: number;
    waiting: number;
    shellTotal: number;
    shellAvailable: number;
  }> {
    const entries = await this.liveEntries(account, machineId, ledger);
    let available = 0;
    let seeding = 0;
    let waiting = 0;
    let shellTotal = 0;
    let shellAvailable = 0;
    for (const e of entries) {
      if (e.availability === "available") available++;
      else if (e.availability === "seeding") seeding++;
      else waiting++;
      if (isShellPath(e.packPath)) {
        shellTotal++;
        if (e.availability === "available") shellAvailable++;
      }
    }
    return {
      total: entries.length,
      available,
      seeding,
      waiting,
      shellTotal,
      shellAvailable
    };
  }

  shutdown(): void {
    this.docsCache.clear();
  }
}
