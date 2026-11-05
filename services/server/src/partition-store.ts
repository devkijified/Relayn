// =========================================================================
// RELAYN: Partition store (TypeScript)
// -------------------------------------------------------------------------
// THE PARTITION slice-1: a per-account, per-machine MATERIALIZED VIEW over
// the sealed move store. Sealed moves at
//   <accountId>/<moveId>/{meta,manifest,chunks/} in the object store
// remain the bytes' home. This store holds enumerations, fetched-file
// refs (moveId + packPath + size + modTime), and a Partition-side
// mutate ledger (Delete + Rename only). It never copies sealed chunks
// into a second unmanaged byte store.
//
// Operator auth is account-scoped (X-Account-Id), same model as the
// headless operator channel. Source machines stay READ-ONLY: mutate
// never reaches a Host.
//
// BASE: build stamp 202610281436, commit f987671.
// =========================================================================

import { randomBytes } from "node:crypto";

import type { MoverStore } from "./mover-store.js";
import type { StateDocs } from "./storage.js";
import type { PartitionCatalog } from "./partition-catalog.js";

export interface PartitionFileRef {
  packPath: string;
  moveId: string;
  size: number;
  modTime: number; // unix seconds; 0 when unknown
  category: string;
  sha256?: string;
}

export interface PartitionChild {
  name: string;
  path: string; // pack path (dir or file)
  kind: "dir" | "file";
  size: number;
  modTime: number;
  moveId?: string;
  category?: string;
}

export interface PartitionMutateRecord {
  id: string;
  accountId: string;
  machineId: string;
  op: "delete" | "rename";
  path: string;
  newName?: string;
  at: string; // RFC3339
  confirmed: true;
}

export interface PartitionMachineView {
  machineId: string;
  fileCount: number;
  moveIds: string[];
  updatedAt: string;
  gaps: string[];
  /** Files under the shell-set prefixes (Desktop, Start Menu, TaskBar pins, wallpaper). */
  shellFileCount?: number;
  /** True when fileCount===0 or shellFileCount===0 (Viewer also gates shell-empty on online). */
  stale?: boolean;
}

interface MachineIndex {
  // live packPath -> ref (after applying mutate ledger)
  files: Map<string, PartitionFileRef>;
  // moveIds contributing to this view
  moveIds: Set<string>;
  updatedAt: string;
}

/** The persisted shape of a MachineIndex (file refs before the
 * mutate ledger is applied, exactly as rebuild holds them). */
interface PersistedMachineIndex {
  files: PartitionFileRef[];
  moveIds: string[];
  updatedAt: string;
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

function baseName(packPath: string): string {
  const i = packPath.lastIndexOf("/");
  return i < 0 ? packPath : packPath.slice(i + 1);
}

/**
 * PartitionStore builds and serves the Partition tree as a view over
 * MoverStore sealed moves. Object layout for the ledger only:
 *   <accountId>/_partition/<machineId>/ledger.json
 * File bytes are NEVER written here. Ledger writes are atomic
 * (single-object writes, see storage.ts), and a corrupt ledger
 * logs loudly and starts empty instead of crashing the read. The
 * per-machine index is a derived view over the sealed moves; it
 * is held in memory AND persisted beside the ledger on every
 * rebuild, so a server restart serves the standing view from the
 * persisted copy instead of re-reading every sealed manifest.
 * A rebuild from the sealed moves remains the fallback when no
 * persisted index exists, and stays the writer that refreshes
 * the persisted copy.
 */
/** Shell-set prefixes the Partition auto-pull always pulls first. */
export const PARTITION_SHELL_PREFIXES = [
  "files/Desktop",
  "files/PublicDesktop",
  "appData/Roaming/Microsoft/Windows/Start Menu/Programs",
  "appData/Roaming/Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar",
  "setup/pins-public",
  "setup/wallpaper"
];

function shellFileCountOf(files: Map<string, PartitionFileRef>): number {
  let n = 0;
  for (const packPath of files.keys()) {
    for (const pref of PARTITION_SHELL_PREFIXES) {
      if (packPath === pref || packPath.startsWith(pref + "/")) {
        n++;
        break;
      }
    }
  }
  return n;
}

export class PartitionStore {
  private indexes = new Map<string, Map<string, MachineIndex>>(); // account -> machineId -> index
  private ledgers = new Map<string, PartitionMutateRecord[]>(); // account|machineId -> records
  private readonly docs: StateDocs;
  // Catalog-first (doc 23): the standing catalog is the Partition
  // listing source. Sealed-move rebuild CONFIRMS available rows + moveId
  // into it. Optional so direct constructions (and old call sites) keep
  // working; index.ts wires it in production.
  private readonly catalog?: PartitionCatalog;

  constructor(
    private readonly moverStore: MoverStore,
    docs?: StateDocs,
    catalog?: PartitionCatalog
  ) {
    this.docs = docs ?? moverStore.docs;
    this.catalog = catalog;
  }

  /** The catalog this store confirms available rows into (may be unset). */
  getCatalog(): PartitionCatalog | undefined {
    return this.catalog;
  }

  private accMap(account: string): Map<string, MachineIndex> {
    let m = this.indexes.get(account);
    if (!m) {
      m = new Map();
      this.indexes.set(account, m);
    }
    return m;
  }

  private ledgerKey(account: string, machineId: string): string {
    return account + "|" + machineId;
  }

  private ledgerObjectKey(account: string, machineId: string): string {
    return `${account}/_partition/${machineId}/ledger.json`;
  }

  private indexObjectKey(account: string, machineId: string): string {
    return `${account}/_partition/${machineId}/index.json`;
  }

  /** Persist the built index next to the ledger, so a restart can
   * serve the standing view without re-reading sealed manifests. */
  private async saveIndex(
    account: string,
    machineId: string,
    idx: MachineIndex
  ): Promise<void> {
    const persisted: PersistedMachineIndex = {
      files: Array.from(idx.files.values()),
      moveIds: Array.from(idx.moveIds),
      updatedAt: idx.updatedAt
    };
    await this.docs.saveText(
      this.indexObjectKey(account, machineId),
      JSON.stringify(persisted, null, 2)
    );
  }

  /** Load a persisted index, or undefined when none exists (or it
   * is corrupt, which logs loudly like a corrupt ledger does). */
  private async loadPersistedIndex(
    account: string,
    machineId: string
  ): Promise<MachineIndex | undefined> {
    const raw = await this.docs.loadText(
      this.indexObjectKey(account, machineId)
    );
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedMachineIndex>;
      if (!parsed || !Array.isArray(parsed.files)) {
        throw new Error("persisted index has no files array");
      }
      const files = new Map<string, PartitionFileRef>();
      for (const f of parsed.files) {
        if (!f || typeof f !== "object") continue;
        const packPath = typeof f.packPath === "string" ? f.packPath : "";
        if (!packPath || packPath.includes("..")) continue;
        files.set(packPath, {
          packPath,
          moveId: typeof f.moveId === "string" ? f.moveId : "",
          size: typeof f.size === "number" ? f.size : 0,
          modTime: typeof f.modTime === "number" ? f.modTime : 0,
          category:
            typeof f.category === "string" ? f.category : categoryOf(packPath),
          sha256: typeof f.sha256 === "string" ? f.sha256 : undefined
        });
      }
      const moveIds = new Set<string>(
        Array.isArray(parsed.moveIds)
          ? parsed.moveIds.filter((m): m is string => typeof m === "string")
          : []
      );
      return {
        files,
        moveIds,
        updatedAt:
          typeof parsed.updatedAt === "string" && parsed.updatedAt
            ? parsed.updatedAt
            : rfc3339Now()
      };
    } catch (err) {
      console.error(
        `[relayn] PARTITION INDEX CORRUPT: ${this.indexObjectKey(account, machineId)} ` +
          `could not be loaded (${(err as Error).message}). Falling back to ` +
          `a rebuild from the sealed moves; the sealed moves are untouched.`
      );
      return undefined;
    }
  }

  async loadLedger(
    account: string,
    machineId: string
  ): Promise<PartitionMutateRecord[]> {
    const key = this.ledgerKey(account, machineId);
    const cached = this.ledgers.get(key);
    if (cached) return cached;
    let records: PartitionMutateRecord[] = [];
    const raw = await this.docs.loadText(
      this.ledgerObjectKey(account, machineId)
    );
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          records = parsed.filter(
            (r): r is PartitionMutateRecord =>
              !!r &&
              typeof r === "object" &&
              (r as PartitionMutateRecord).confirmed === true &&
              ((r as PartitionMutateRecord).op === "delete" ||
                (r as PartitionMutateRecord).op === "rename")
          );
        }
      } catch (err) {
        console.error(
          `[relayn] PARTITION LEDGER CORRUPT: ${this.ledgerObjectKey(account, machineId)} ` +
            `could not be parsed (${(err as Error).message}). Starting that ` +
            `machine's ledger empty; the sealed moves are untouched.`
        );
        records = [];
      }
    }
    this.ledgers.set(key, records);
    return records;
  }

  private async saveLedger(
    account: string,
    machineId: string,
    records: PartitionMutateRecord[]
  ): Promise<void> {
    const key = this.ledgerKey(account, machineId);
    this.ledgers.set(key, records);
    await this.docs.saveText(
      this.ledgerObjectKey(account, machineId),
      JSON.stringify(records, null, 2)
    );
  }

  /**
   * Rebuild the per-machine view from sealed move manifests.
   * Matching rule (honest, named): a move is bound to a machine when
   * manifest.sourceName equals the machineId or the machine's enrolled
   * name (case-insensitive), OR when the move's moverName matches.
   * Moves that cannot be bound are skipped and named in gaps.
   */
  async rebuildFromSealedMoves(
    account: string,
    machineId: string,
    machineName?: string
  ): Promise<PartitionMachineView> {
    const moves = await this.moverStore.listMoves(account);
    const files = new Map<string, PartitionFileRef>();
    const moveIds = new Set<string>();
    const gaps: string[] = [];
    const nameLc = (machineName || "").trim().toLowerCase();
    const idLc = machineId.trim().toLowerCase();

    let unbound = 0;
    for (const meta of moves) {
      const manifest = await this.moverStore.getManifest(account, meta.moveId);
      if (!manifest || typeof manifest !== "object") continue;
      const m = manifest as Record<string, unknown>;
      const sourceName =
        typeof m.sourceName === "string" ? m.sourceName.trim() : "";
      const moverName =
        typeof meta.moverName === "string" ? meta.moverName.trim() : "";
      const srcLc = sourceName.toLowerCase();
      const movLc = moverName.toLowerCase();
      const bound =
        (srcLc && (srcLc === idLc || (nameLc && srcLc === nameLc))) ||
        (movLc && (movLc === idLc || (nameLc && movLc === nameLc)));
      if (!bound) {
        unbound++;
        continue;
      }
      moveIds.add(meta.moveId);
      const fileList = Array.isArray(m.files) ? m.files : [];
      for (const f of fileList) {
        if (!f || typeof f !== "object") continue;
        const fr = f as Record<string, unknown>;
        const packPath = typeof fr.path === "string" ? fr.path : "";
        if (!packPath || packPath.includes("..")) continue;
        // Later moves win on the same packPath (fresher sealed bytes).
        files.set(packPath, {
          packPath,
          moveId: meta.moveId,
          size: typeof fr.size === "number" ? fr.size : 0,
          modTime: typeof fr.modTime === "number" ? fr.modTime : 0,
          category:
            typeof fr.category === "string"
              ? fr.category
              : categoryOf(packPath),
          sha256: typeof fr.sha256 === "string" ? fr.sha256 : undefined
        });
      }
    }
    if (unbound > 0) {
      gaps.push(
        unbound +
          " sealed move(s) on this account could not be bound to machine " +
          machineId +
          " (sourceName/moverName mismatch); they stay in the sealed store but are not in this Partition view"
      );
    }
    if (moveIds.size === 0) {
      gaps.push(
        "No sealed moves bound to this machine yet. Partition Explorer shows an empty tree until a move whose sourceName or moverName matches this machine is present. Opening Partition starts an automatic pull from the Host when the machine is online."
      );
    }
    gaps.push(
      "Sealed chunks remain ciphertext in the move store; plaintext document open is Viewer-local via account-derived pack key + assembleMove. No second unmanaged byte store."
    );
    // Installed-apps / Start Menu known-folder: not in 1436 inventory
    // categories (files, appData, setup, browserPrep). Named for Muse.
    gaps.push(
      "Inventory categories in BASE 1436 are files/appData/setup/browserPrep only. Start Menu known folder is skipped as an AppData link (machine.go). Installed-apps is mover-spec Phase 2, not a live category. TaskBar pins reachable only when AppData Quick Launch User Pinned TaskBar paths are present in a bound move."
    );

    const updatedAt = rfc3339Now();
    this.accMap(account).set(machineId, { files, moveIds, updatedAt });
    // Persist the fresh index beside the ledger: after a server
    // restart the standing view serves from this copy instead of
    // re-reading every sealed manifest (see ensureIndex).
    await this.saveIndex(account, machineId, { files, moveIds, updatedAt });
    // Apply ledger on top for serving.
    await this.loadLedger(account, machineId);

    const shellFileCount = shellFileCountOf(files);
    // Catalog-first integration (ruling A): the rebuild confirms the
    // sealed, hash-bearing rows into the standing catalog as `available`
    // with their moveId bound. The catalog is the Partition listing
    // source; this keeps it in step with the freshest sealed bytes.
    if (this.catalog) {
      const refs = Array.from(files.values()).map((ref) => ({
        packPath: ref.packPath,
        size: ref.size,
        modTime: ref.modTime,
        moveId: ref.moveId,
        category: ref.category,
        sha256: ref.sha256
      }));
      await this.catalog.confirmAvailableFromRefs(account, machineId, refs);
    }
    return {
      machineId,
      fileCount: files.size,
      moveIds: Array.from(moveIds),
      updatedAt,
      gaps,
      shellFileCount,
      stale: files.size === 0 || shellFileCount === 0
    };
  }

  private async ensureIndex(
    account: string,
    machineId: string,
    machineName?: string
  ): Promise<MachineIndex> {
    const existing = this.accMap(account).get(machineId);
    if (existing) return existing;
    // Memory is cold (a restart, most likely): the persisted
    // index from the last rebuild serves the standing view with
    // zero manifest reads. The mutate ledger still applies on
    // the serve path (liveFiles), exactly as before. Only when
    // no persisted index exists do we rebuild from sealed moves.
    const persisted = await this.loadPersistedIndex(account, machineId);
    if (persisted) {
      this.accMap(account).set(machineId, persisted);
      return persisted;
    }
    await this.rebuildFromSealedMoves(account, machineId, machineName);
    return (
      this.accMap(account).get(machineId) || {
        files: new Map(),
        moveIds: new Set(),
        updatedAt: rfc3339Now()
      }
    );
  }

  /** Live file map after Delete/Rename ledger overlays. */
  private async liveFiles(
    account: string,
    machineId: string,
    machineName?: string
  ): Promise<Map<string, PartitionFileRef>> {
    const idx = await this.ensureIndex(account, machineId, machineName);
    const out = new Map(idx.files);
    const ledger = await this.loadLedger(account, machineId);
    for (const rec of ledger) {
      if (rec.op === "delete") {
        out.delete(rec.path);
        // Also drop children when a directory path was deleted.
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
        // Folder rename: mutate accepts a folder path (one with
        // children), so its children move with it.
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

  async status(
    account: string,
    machineId: string,
    machineName?: string
  ): Promise<PartitionMachineView> {
    const idx = await this.ensureIndex(account, machineId, machineName);
    const live = await this.liveFiles(account, machineId, machineName);
    const gaps: string[] = [];
    if (live.size === 0) {
      gaps.push(
        "No sealed moves bound to this machine yet. Partition shows an empty desktop until a move whose sourceName or moverName matches this machine is present."
      );
    }
    const shellFileCount = shellFileCountOf(live);
    return {
      machineId,
      fileCount: live.size,
      moveIds: Array.from(idx.moveIds),
      updatedAt: idx.updatedAt,
      gaps,
      shellFileCount,
      stale: live.size === 0 || shellFileCount === 0
    };
  }

  async browse(
    account: string,
    machineId: string,
    prefix: string,
    opts?: { machineName?: string; offset?: number; limit?: number }
  ): Promise<{ prefix: string; children: PartitionChild[]; total: number }> {
    const live = await this.liveFiles(
      account,
      machineId,
      opts?.machineName
    );
    const pfx = (prefix || "").replace(/^\/+|\/+$/g, "");
    const offset = Math.max(0, opts?.offset || 0);
    const limit = Math.min(500, Math.max(1, opts?.limit || 200));

    const dirs = new Map<string, PartitionChild>();
    const files: PartitionChild[] = [];

    for (const [packPath, ref] of live) {
      if (pfx) {
        if (packPath !== pfx && !packPath.startsWith(pfx + "/")) continue;
        if (packPath === pfx) continue; // the prefix itself
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
            size: ref.size,
            modTime: ref.modTime,
            moveId: ref.moveId,
            category: ref.category
          });
        }
      } else {
        // Root: top-level category / first segment.
        const slash = packPath.indexOf("/");
        const name = slash < 0 ? packPath : packPath.slice(0, slash);
        const dirPath = name;
        if (!dirs.has(dirPath)) {
          dirs.set(dirPath, {
            name,
            path: dirPath,
            kind: "dir",
            size: 0,
            modTime: 0
          });
        }
      }
    }

    const children = [
      ...Array.from(dirs.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
      ...files.sort((a, b) => a.name.localeCompare(b.name))
    ];
    const total = children.length;
    return {
      prefix: pfx,
      children: children.slice(offset, offset + limit),
      total
    };
  }

  async documentMeta(
    account: string,
    machineId: string,
    packPath: string,
    machineName?: string
  ): Promise<PartitionFileRef | undefined> {
    const live = await this.liveFiles(account, machineId, machineName);
    return live.get(packPath);
  }

  async wallpaper(
    account: string,
    machineId: string,
    machineName?: string
  ): Promise<PartitionFileRef | undefined> {
    const live = await this.liveFiles(account, machineId, machineName);
    let best: PartitionFileRef | undefined;
    for (const [p, ref] of live) {
      if (p === "setup/wallpaper" || p.startsWith("setup/wallpaper/")) {
        if (!best || ref.modTime >= best.modTime) best = ref;
      }
    }
    return best;
  }

  async desktopIcons(
    account: string,
    machineId: string,
    machineName?: string
  ): Promise<PartitionChild[]> {
    const listed = await this.browse(account, machineId, "files/Desktop", {
      machineName,
      limit: 500
    });
    return listed.children;
  }

  /**
   * Pins from EXISTING doors / pack paths (ruling B/C).
   * TaskBar: appData/.../Quick Launch/User Pinned/TaskBar
   * Start Menu Programs: appData/.../Start Menu/Programs (+ ProgramData if present)
   * No speculative start2.bin inventory command in this drop.
   */
  async pins(
    account: string,
    machineId: string,
    machineName?: string
  ): Promise<{
    taskbar: PartitionChild[];
    startPrograms: PartitionChild[];
    notes: string[];
  }> {
    const live = await this.liveFiles(account, machineId, machineName);
    const taskbar: PartitionChild[] = [];
    const startPrograms: PartitionChild[] = [];
    const notes: string[] = [];

    const taskbarNeedle = "Quick Launch/User Pinned/TaskBar".toLowerCase();
    const startNeedle = "Start Menu/Programs".toLowerCase();

    for (const [p, ref] of live) {
      const lc = p.toLowerCase();
      if (lc.includes(taskbarNeedle) && !p.endsWith("/")) {
        // file under TaskBar
        if (!lc.endsWith("/taskbar")) {
          taskbar.push({
            name: baseName(p),
            path: p,
            kind: "file",
            size: ref.size,
            modTime: ref.modTime,
            moveId: ref.moveId,
            category: ref.category
          });
        }
      }
      if (lc.includes(startNeedle) && !p.endsWith("/")) {
        startPrograms.push({
          name: baseName(p),
          path: p,
          kind: "file",
          size: ref.size,
          modTime: ref.modTime,
          moveId: ref.moveId,
          category: ref.category
        });
      }
    }

    if (taskbar.length === 0) {
      notes.push(
        "No TaskBar pin files under AppData Quick Launch User Pinned TaskBar in bound moves yet."
      );
    }
    if (startPrograms.length === 0) {
      notes.push(
        "No Start Menu Programs entries in bound moves yet. Start Menu known folder is skipped by inventory (machine.go); pins appear only when those AppData paths were pulled into a sealed move."
      );
    }
    notes.push(
      "Win11 Start pinned layout (start2.bin) is NOT inventoried in this drop: no evidence that existing enumeration reaches it; no speculative READ-ONLY command shipped (ruling B/C)."
    );
    notes.push(
      "Installed-apps category is mover-spec Phase 2 and is not present in BASE 1436 inventory categories."
    );

    return { taskbar, startPrograms, notes };
  }

  /**
   * Delete or Rename on the Partition view only. Requires confirmed:true.
   * Never reaches the source machine. Written to the partition ledger.
   */
  async mutate(
    account: string,
    machineId: string,
    body: {
      op: "delete" | "rename";
      path: string;
      newName?: string;
      confirmed?: boolean;
    }
  ): Promise<PartitionMutateRecord> {
    if (body.confirmed !== true) {
      throw Object.assign(new Error("confirmed:true required"), {
        statusCode: 400
      });
    }
    if (body.op !== "delete" && body.op !== "rename") {
      throw Object.assign(new Error("op must be delete or rename"), {
        statusCode: 400
      });
    }
    const packPath = String(body.path || "").replace(/^\/+|\/+$/g, "");
    if (!packPath || packPath.includes("..")) {
      throw Object.assign(new Error("valid path required"), { statusCode: 400 });
    }
    if (body.op === "rename") {
      const nn = String(body.newName || "").trim();
      if (!nn || nn.includes("/") || nn.includes("..") || nn.includes("\\")) {
        throw Object.assign(new Error("valid newName required"), {
          statusCode: 400
        });
      }
    }
    const live = await this.liveFiles(account, machineId);
    const exact = live.has(packPath);
    let hasChild = false;
    for (const p of live.keys()) {
      if (p.startsWith(packPath + "/")) {
        hasChild = true;
        break;
      }
    }
    if (!exact && !hasChild) {
      throw Object.assign(new Error("path not in Partition view"), {
        statusCode: 404
      });
    }

    const rec: PartitionMutateRecord = {
      id: "pm-" + randomBytes(8).toString("hex"),
      accountId: account,
      machineId,
      op: body.op,
      path: packPath,
      newName: body.op === "rename" ? String(body.newName).trim() : undefined,
      at: rfc3339Now(),
      confirmed: true
    };
    const ledger = await this.loadLedger(account, machineId);
    ledger.push(rec);
    await this.saveLedger(account, machineId, ledger);
    return rec;
  }

  listLedger(
    account: string,
    machineId: string
  ): Promise<PartitionMutateRecord[]> {
    return this.loadLedger(account, machineId);
  }

  shutdown(): void {
    this.indexes.clear();
    this.ledgers.clear();
  }
}
