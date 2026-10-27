// =========================================================================
// RELAYN MOVER — cloud coordination store (disk-backed, TypeScript)
// -------------------------------------------------------------------------
// Port of the Relayn Mover Go cloud server (relayn-mover/cmd/cloud).
// The cloud is the coordination layer for Mover, the same role this
// server already plays for the extension: account pairing, machine
// presence, the moves inbox. It also offers a store-and-forward chunk
// relay for when the two apps cannot reach each other directly:
// sealed (already AES-256-GCM encrypted) chunks rest in a per-account
// data directory until the Admin pulls them. The server never sees
// plaintext and never sees a pack key.
//
// Every lookup resolves inside <dataDir>/<accountId>/ only, so one
// pair can never list, fetch or stream another pair's moves.
// Possession of the account ID IS the authorization — the standing
// Relayn account model (see share-store.ts).
//
// Layout on disk:
//   <dataDir>/<accountId>/<moveId>/meta.json      (MoveMeta)
//   <dataDir>/<accountId>/<moveId>/manifest.json  (the pack manifest)
//   <dataDir>/<accountId>/<moveId>/chunks/<n>     (one sealed chunk)
//
// Presence (machines) is held in memory only, exactly like the Go
// server: a restart clears it and the apps re-register on heartbeat.
//
// Configuration (env, defaults match the Go cloud config):
//   MOVER_DATA_DIR          ./mover-data
//   MOVER_RETENTION_HOURS   168   (move dirs older than this are swept;
//                                  0 keeps everything forever)
//   MOVER_CLEANUP_EVERY_MIN 60
//   MOVER_MAX_CHUNK_MB      64    (per-chunk upload cap; 0 = no cap)
// =========================================================================

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface MoverMachine {
  account: string;
  role: string;
  name: string;
  address: string; // peer base URL, e.g. http://100.64.0.2:8771
}

export interface MoveMeta {
  moveId: string;
  account: string;
  moverName: string;
  name: string;
  totalBytes: number;
  totalFiles: number;
  chunks: number;
  status: string; // announced, sending, sent
  createdAt: string; // RFC3339 UTC
}

// -----------------------------------------------------------------
// Headless machines: enrolled engines that run with NO signed-in
// user. A machine enrolls once per account and receives a per-machine
// secret; after that it authenticates with X-Machine-Id +
// X-Machine-Secret. The console queues commands (scan, browse, paths,
// start, files-browse, files-fetch, files-push); the machine polls
// for them, executes, and posts results back. "start", "files-fetch"
// and "files-push" commands are SIGNED with the machine's secret (see
// headlessCommandSignature) so a start exists only because an
// operator clicked it in the console — never zero-touch.
//
// Headless state is held IN MEMORY, exactly like presence above: a
// server restart clears enrollments, queued commands and results,
// and machines simply re-enroll (the same recovery presence uses).
// -----------------------------------------------------------------

export interface HeadlessMachineRecord {
  account: string;
  machineId: string;
  name: string;
  os: string;
  profiles: unknown; // as enrolled (engine-defined, typically names)
  capabilities: unknown; // as enrolled, e.g. { desktop: true }
  secret: string;
  enrolledAt: string; // RFC3339 UTC
  lastSeenMs: number; // epoch ms of the last enroll/heartbeat
  state: string; // engine-reported: idle, scanning, moving, ...
  jobId: string; // engine-reported current job, "" when none
  progress: unknown; // engine-reported progress for the current job
  deskSession: DeskSessionRecord | null; // Background Admin ledger
  viewSession: ViewSessionRecord | null; // View Screen ledger
  interactiveUser: string; // who is signed in at the console ("" = nobody)
  interactiveAway: boolean; // the signed-in pick's session is not live (disconnected/idle)
  sessionsDiag: SessionsDiag | null; // compact session evidence behind the signed-in claim
  pollOk: boolean | null; // last command poll landed (null = unreported)
  pollError: string; // short failure reason when the last poll failed
  pollAt: string; // RFC3339 of the last poll outcome
  runMode: string; // how the guard is hosted: "service" | "foreground" | "" (unreported)
}

/**
 * The compact session diagnostic the engine folds into
 * enrollments and heartbeats: how many sessions carry a user,
 * split by state class, which session the selection picked
 * (0 when none), and whether that pick is away. It exists so a
 * "no one is signed in" claim in the console is always backed
 * by the counts behind it (the owner's server reported nobody
 * while a disconnected admin session sat on it, 2026-10-27).
 */
export interface SessionsDiag {
  users: number;
  active: number;
  connected: number;
  disconnected: number;
  other: number;
  picked: number;
  away: boolean;
}

/**
 * Validate and clamp an engine-sent session diagnostic. The
 * fields are counts the engine computed over its own session
 * table; anything malformed folds to null (unreported), never
 * to invented numbers.
 */
export function foldSessionsDiag(value: unknown): SessionsDiag | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const count = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) && x >= 0
      ? Math.min(Math.floor(x), 100000)
      : null;
  const users = count(v.users);
  const active = count(v.active);
  const connected = count(v.connected);
  const disconnected = count(v.disconnected);
  const other = count(v.other);
  const picked = count(v.picked);
  if (
    users === null || active === null || connected === null ||
    disconnected === null || other === null || picked === null
  ) {
    return null;
  }
  return {
    users, active, connected, disconnected, other, picked,
    away: v.away === true
  };
}

/**
 * The Background Admin session ledger for one machine: the current
 * or most recent private-desktop session. Fed by desk command
 * results and heartbeat desk reports. "endedBy" is "admin" when
 * the admin ended it from the viewer or console, "idle" when the
 * engine's idle TTL ended it on its own.
 */
export interface DeskSessionRecord {
  sessionId: string;
  state: "live" | "ended";
  openedAt: string; // RFC3339 UTC
  endedAt?: string; // RFC3339 UTC
  endedBy?: "admin" | "idle";
  framesServed: number;
}

/**
 * The View Screen session ledger: the desk ledger's twin for the
 * view-only stream of the interactive desktop. Independent of
 * the desk record in every way (a machine can hold both at once;
 * each closes by its own end). "endedBy" adds "session-gone":
 * the signed-in session ended under the view (logoff or a
 * session switch), which the engine reports by heartbeat.
 */
export interface ViewSessionRecord {
  sessionId: string;
  state: "live" | "ended";
  openedAt: string; // RFC3339 UTC
  endedAt?: string; // RFC3339 UTC
  endedBy?: "admin" | "idle" | "session-gone";
  framesServed: number;
  user?: string; // who is signed in and being viewed
}

/** The console-facing shape: everything except the secret. */
export interface HeadlessMachineView {
  machineId: string;
  name: string;
  os: string;
  profiles: unknown;
  capabilities: unknown;
  enrolledAt: string;
  lastSeen: string; // RFC3339 UTC
  online: boolean;
  state: string;
  jobId: string;
  progress: unknown;
  deskSession: DeskSessionRecord | null;
  viewSession: ViewSessionRecord | null;
  interactiveUser: string;
  interactiveAway: boolean;
  sessionsDiag: SessionsDiag | null;
  pollOk: boolean | null;
  pollError: string;
  pollAt: string;
  runMode: string;
}

export interface HeadlessCommand {
  id: string;
  account: string;
  machineId: string;
  type: string; // scan | browse | paths | start | desk-open | desk-frame | desk-input | desk-launch | desk-end | view-open | view-frame | view-end | files-browse | files-fetch | files-push
  payload: Record<string, unknown>;
  signature?: string; // set for "start", "desk-end", "view-end", "files-fetch" and "files-push" commands
  createdAt: string; // RFC3339 UTC
  status: "pending" | "delivered" | "done";
  result?: unknown;
  resultAt?: string; // RFC3339 UTC
}

/**
 * One entry in the Files transfer ledger: a single file a machine
 * reports moving under a files-fetch or files-push command. The
 * record is the server's fold of the machine's own report entry
 * ({ direction, path, size, outcome }) plus who reported it and
 * when the server received the report ("at", RFC3339 UTC). The
 * ledger is held in memory, like presence and the session
 * ledgers: a restart clears it and new transfers refill it.
 */
export interface FilesTransferRecord {
  accountId: string;
  machineId: string;
  direction: string;
  path: string;
  size: number;
  outcome: string;
  at: string; // RFC3339 UTC, server receipt time
}

/** A machine reads as online when seen within this window. */
export const HEADLESS_ONLINE_MS = 30_000;

const HEADLESS_MACHINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidHeadlessMachineId(input: unknown): input is string {
  return typeof input === "string" && HEADLESS_MACHINE_ID_RE.test(input);
}

/**
 * Canonical JSON: object keys sorted recursively, arrays in order,
 * no whitespace — plain JSON.stringify of a key-sorted deep copy.
 * The engine recomputes signatures over exactly this encoding.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`
  );
  return `{${parts.join(",")}}`;
}

/**
 * Command signature: HMAC-SHA256 (hex) over the canonical JSON of
 * { id, type, payload }, keyed with the machine's secret.
 */
export function headlessCommandSignature(
  secret: string,
  cmd: { id: string; type: string; payload: unknown }
): string {
  return createHmac("sha256", secret)
    .update(
      canonicalJson({ id: cmd.id, type: cmd.type, payload: cmd.payload }),
      "utf8"
    )
    .digest("hex");
}

function headlessMachineView(
  rec: HeadlessMachineRecord
): HeadlessMachineView {
  return {
    machineId: rec.machineId,
    name: rec.name,
    os: rec.os,
    profiles: rec.profiles,
    capabilities: rec.capabilities,
    enrolledAt: rec.enrolledAt,
    lastSeen: new Date(rec.lastSeenMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    online: Date.now() - rec.lastSeenMs <= HEADLESS_ONLINE_MS,
    state: rec.state,
    jobId: rec.jobId,
    progress: rec.progress,
    deskSession: rec.deskSession,
    viewSession: rec.viewSession,
    interactiveUser: rec.interactiveUser,
    interactiveAway: rec.interactiveAway,
    sessionsDiag: rec.sessionsDiag,
    pollOk: rec.pollOk,
    pollError: rec.pollError,
    pollAt: rec.pollAt,
    runMode: rec.runMode
  };
}

export interface MoverCloudConfig {
  dataDir: string;
  retentionHours: number;
  cleanupEveryMin: number;
  maxChunkMB: number;
  /** Effective per-chunk cap in bytes; 0 means no explicit cap. */
  maxChunkBytes: number;
}

function envInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export function loadMoverConfig(
  env: NodeJS.ProcessEnv = process.env
): MoverCloudConfig {
  const maxChunkMB = envInt(env.MOVER_MAX_CHUNK_MB, 64, 0, 4096);
  return {
    dataDir: env.MOVER_DATA_DIR?.trim() || "./mover-data",
    retentionHours: envInt(env.MOVER_RETENTION_HOURS, 168, 0, 24 * 365),
    cleanupEveryMin: envInt(env.MOVER_CLEANUP_EVERY_MIN, 60, 1, 24 * 60),
    maxChunkMB,
    maxChunkBytes: maxChunkMB > 0 ? maxChunkMB * 1024 * 1024 : 0
  };
}

/*
 * Move IDs become path segments. The Go client only ever generates
 * "move-<unixnano>-<pid>", but the announce body is client-supplied,
 * so the port validates the segment shape instead of trusting it —
 * anything else reads as "not found" (or a 400 at announce time).
 */
const MOVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidMoveId(input: unknown): input is string {
  return typeof input === "string" && MOVE_ID_RE.test(input);
}

/** Go's time.RFC3339 UTC format: seconds precision, trailing Z. */
function rfc3339Now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function writeFileJSON(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function readFileJSON<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export class MoverStore {
  readonly config: MoverCloudConfig;
  private machines = new Map<string, MoverMachine[]>();
  private headlessMachines = new Map<
    string,
    Map<string, HeadlessMachineRecord>
  >();
  private headlessCommands = new Map<string, HeadlessCommand>();
  private filesTransfers: FilesTransferRecord[] = [];
  private sweepTimer?: NodeJS.Timeout;

  constructor(config: MoverCloudConfig = loadMoverConfig()) {
    this.config = config;
    mkdirSync(this.config.dataDir, { recursive: true });
    // Retention sweep (Go cleanupLoop): move directories whose mtime
    // is older than the retention window are deleted. Zero retention
    // keeps everything forever.
    if (this.config.retentionHours > 0) {
      this.sweepTimer = setInterval(
        () => {
          void this.sweepExpired();
        },
        this.config.cleanupEveryMin * 60_000
      );
      this.sweepTimer.unref();
    }
  }

  shutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // -----------------------------------------------------------------
  // Presence (in-memory, like the Go server)
  // -----------------------------------------------------------------

  /** Register or heartbeat: same (role, name) replaces the old record. */
  registerMachine(account: string, machine: MoverMachine): void {
    const kept = (this.machines.get(account) ?? []).filter(
      (old) => !(old.role === machine.role && old.name === machine.name)
    );
    kept.push({ ...machine, account });
    this.machines.set(account, kept);
  }

  listMachines(account: string): MoverMachine[] {
    return this.machines.get(account) ?? [];
  }

  // -----------------------------------------------------------------
  // Headless machines (in-memory, like presence: a restart clears
  // enrollments, queued commands and results; machines re-enroll)
  // -----------------------------------------------------------------

  /**
   * Enroll (or re-enroll) a machine: a fresh per-machine secret is
   * generated and returned in the record; the caller hands it to the
   * machine once. Re-enrolling the same machineId replaces the
   * record and drops only its NEVER-DELIVERED commands
   * (status "pending": queued, but not yet taken by a poll) — they
   * were sealed for the old secret, and a "start" among them carries
   * a signature the machine can no longer verify.
   *
   * Commands already delivered (status "delivered") are IN FLIGHT
   * and survive re-enroll and secret rotation, together with their
   * result slots: the engine re-enrolls after any 401 (e.g. a
   * restart with a rotated secret) and must still be able to post
   * the result of a command it is already executing — a resumed
   * mid-flight job would otherwise lose its result channel. The
   * engine dedups a start whose id matches its persisted job, so
   * keeping delivered commands server-side is safe. Commands with a
   * stored result (status "done") also survive.
   */
  enrollHeadlessMachine(
    account: string,
    init: {
      machineId: string;
      name: string;
      os: string;
      profiles: unknown;
      capabilities: unknown;
      interactiveUser?: unknown;
      interactiveAway?: unknown;
      sessionsDiag?: unknown;
      runMode?: unknown;
    }
  ): HeadlessMachineRecord {
    const rec: HeadlessMachineRecord = {
      account,
      machineId: init.machineId,
      name: init.name,
      os: init.os,
      profiles: init.profiles,
      capabilities: init.capabilities,
      secret: randomBytes(32).toString("hex"),
      enrolledAt: rfc3339Now(),
      lastSeenMs: Date.now(),
      state: "idle",
      jobId: "",
      progress: null,
      deskSession: null,
      viewSession: null,
      interactiveUser:
        typeof init.interactiveUser === "string" ? init.interactiveUser : "",
      interactiveAway: init.interactiveAway === true,
      sessionsDiag: foldSessionsDiag(init.sessionsDiag),
      pollOk: null,
      pollError: "",
      pollAt: "",
      runMode: typeof init.runMode === "string" ? init.runMode : ""
    };
    let byId = this.headlessMachines.get(account);
    if (!byId) {
      byId = new Map();
      this.headlessMachines.set(account, byId);
    }
    // The session ledgers survive a re-enroll (secret rotation
    // must not erase how a session ended); the engine's next
    // heartbeat refreshes them either way. The same goes for
    // the poll health: enroll bodies say nothing about polls,
    // so a re-enroll must not clear the last poll report (the
    // Go cloud's enroll folds the same way, by not touching
    // the fields).
    const prior = byId.get(init.machineId);
    if (prior) {
      rec.deskSession = prior.deskSession;
      rec.viewSession = prior.viewSession;
      rec.pollOk = prior.pollOk;
      rec.pollError = prior.pollError;
      rec.pollAt = prior.pollAt;
    }
    byId.set(rec.machineId, rec);
    // Drop ONLY never-delivered commands ("pending" here means
    // queued and not yet taken by a poll). Delivered and done
    // commands survive: see the doc comment above.
    for (const [id, cmd] of this.headlessCommands) {
      if (
        cmd.account === account &&
        cmd.machineId === rec.machineId &&
        cmd.status === "pending"
      ) {
        this.headlessCommands.delete(id);
      }
    }
    return rec;
  }

  getHeadlessMachine(
    account: string,
    machineId: string
  ): HeadlessMachineRecord | undefined {
    return this.headlessMachines.get(account)?.get(machineId);
  }

  /** Constant-time secret check; undefined when machine or secret fails. */
  verifyHeadlessMachine(
    account: string,
    machineId: string,
    secret: string
  ): HeadlessMachineRecord | undefined {
    const rec = this.getHeadlessMachine(account, machineId);
    if (!rec) return undefined;
    const given = Buffer.from(secret, "utf8");
    const held = Buffer.from(rec.secret, "utf8");
    if (given.length !== held.length || !timingSafeEqual(given, held)) {
      return undefined;
    }
    return rec;
  }

  listHeadlessMachines(account: string): HeadlessMachineView[] {
    const byId = this.headlessMachines.get(account);
    if (!byId) return [];
    return [...byId.values()]
      .sort((a, b) => (a.machineId < b.machineId ? -1 : 1))
      .map(headlessMachineView);
  }

  /** Heartbeat: always refreshes lastSeen; fields update when present. */
  heartbeatHeadless(
    account: string,
    machineId: string,
    beat: {
      state?: unknown;
      jobId?: unknown;
      progress?: unknown;
      desk?: unknown;
      view?: unknown;
      interactiveUser?: unknown;
      interactiveAway?: unknown;
      sessionsDiag?: unknown;
      poll?: unknown;
      runMode?: unknown;
    }
  ): boolean {
    const rec = this.getHeadlessMachine(account, machineId);
    if (!rec) return false;
    rec.lastSeenMs = Date.now();
    if (typeof beat.state === "string") rec.state = beat.state;
    if (typeof beat.jobId === "string") rec.jobId = beat.jobId;
    if ("progress" in beat) rec.progress = beat.progress;
    if (typeof beat.interactiveUser === "string") {
      rec.interactiveUser = beat.interactiveUser;
    }
    if (typeof beat.interactiveAway === "boolean") {
      rec.interactiveAway = beat.interactiveAway;
    }
    if (beat.sessionsDiag !== undefined) {
      const sd = foldSessionsDiag(beat.sessionsDiag);
      if (sd) rec.sessionsDiag = sd;
    }
    if (typeof beat.poll === "object" && beat.poll !== null) {
      const p = beat.poll as Record<string, unknown>;
      if (typeof p.ok === "boolean") {
        rec.pollOk = p.ok;
        rec.pollError =
          typeof p.error === "string" ? p.error.slice(0, 200) : "";
        rec.pollAt = typeof p.at === "string" ? p.at.slice(0, 40) : "";
      }
    }
    if (typeof beat.runMode === "string") {
      rec.runMode = beat.runMode;
    }
    if (beat.desk !== undefined && beat.desk !== null) {
      this.noteDeskReport(rec, beat.desk);
    }
    if (beat.view !== undefined && beat.view !== null) {
      this.noteViewReport(rec, beat.view);
    }
    return true;
  }

  /**
   * Fold one desk report into the machine's session ledger. A
   * report is the engine's own words: { sessionId, state,
   * openedAt?, endedAt?, endedBy?, framesServed? } — from a
   * heartbeat's desk field or from a desk command result. A live
   * report for a new session id replaces the record; an ended
   * report closes the matching live record.
   */
  noteDeskReport(rec: HeadlessMachineRecord, report: unknown): void {
    if (typeof report !== "object" || report === null) return;
    const r = report as Record<string, unknown>;
    const sessionId = typeof r.sessionId === "string" ? r.sessionId : "";
    if (!sessionId) return;
    const frames =
      typeof r.framesServed === "number" && Number.isFinite(r.framesServed)
        ? Math.max(0, Math.floor(r.framesServed))
        : 0;
    const cur = rec.deskSession;
    if (r.state === "live") {
      if (!cur || cur.sessionId !== sessionId || cur.state !== "live") {
        rec.deskSession = {
          sessionId,
          state: "live",
          openedAt: typeof r.openedAt === "string" ? r.openedAt : rfc3339Now(),
          framesServed: frames
        };
      } else if (frames > cur.framesServed) {
        cur.framesServed = frames;
      }
    } else if (r.state === "ended") {
      if (cur && cur.sessionId === sessionId && cur.state === "live") {
        cur.state = "ended";
        cur.endedBy = r.endedBy === "idle" ? "idle" : "admin";
        cur.endedAt =
          typeof r.endedAt === "string" ? r.endedAt : rfc3339Now();
        if (frames > cur.framesServed) cur.framesServed = frames;
      }
    }
  }

  /**
   * Fold one view report into the machine's view ledger:
   * noteDeskReport's twin, with the viewed user kept on the
   * record and "session-gone" preserved as its own endedBy (an
   * idle end arrives by heartbeat too, an admin end by the
   * signed view-end command's result).
   */
  noteViewReport(rec: HeadlessMachineRecord, report: unknown): void {
    if (typeof report !== "object" || report === null) return;
    const r = report as Record<string, unknown>;
    const sessionId = typeof r.sessionId === "string" ? r.sessionId : "";
    if (!sessionId) return;
    const frames =
      typeof r.framesServed === "number" && Number.isFinite(r.framesServed)
        ? Math.max(0, Math.floor(r.framesServed))
        : 0;
    const cur = rec.viewSession;
    if (r.state === "live") {
      if (!cur || cur.sessionId !== sessionId || cur.state !== "live") {
        rec.viewSession = {
          sessionId,
          state: "live",
          openedAt: typeof r.openedAt === "string" ? r.openedAt : rfc3339Now(),
          framesServed: frames,
          user: typeof r.user === "string" ? r.user : undefined
        };
      } else if (frames > cur.framesServed) {
        cur.framesServed = frames;
      }
    } else if (r.state === "ended") {
      if (cur && cur.sessionId === sessionId && cur.state === "live") {
        cur.state = "ended";
        cur.endedBy =
          r.endedBy === "idle"
            ? "idle"
            : r.endedBy === "session-gone"
              ? "session-gone"
              : "admin";
        cur.endedAt =
          typeof r.endedAt === "string" ? r.endedAt : rfc3339Now();
        if (frames > cur.framesServed) cur.framesServed = frames;
      }
    }
  }

  /**
   * Fold one files-fetch or files-push result's transfer entries
   * into the per-account Files ledger. Each entry is the engine's
   * own words: { direction, path, size, outcome }. Entries with
   * no usable path are skipped; the rest are stamped with the
   * account, the reporting machine and the server receipt time.
   * Heartbeats never carry transfers: results only. Returns how
   * many entries were folded.
   */
  noteFilesTransfers(
    account: string,
    machineId: string,
    transfers: unknown
  ): number {
    if (!Array.isArray(transfers)) return 0;
    let folded = 0;
    for (const entry of transfers) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.path !== "string" || e.path === "") continue;
      this.filesTransfers.push({
        accountId: account,
        machineId,
        direction: typeof e.direction === "string" ? e.direction : "",
        path: e.path,
        size:
          typeof e.size === "number" && Number.isFinite(e.size)
            ? e.size
            : 0,
        outcome: typeof e.outcome === "string" ? e.outcome : "",
        at: rfc3339Now()
      });
      folded++;
    }
    return folded;
  }

  /** This account's Files ledger, newest first. */
  listFilesLedger(account: string): FilesTransferRecord[] {
    return this.filesTransfers
      .filter((r) => r.accountId === account)
      .map((r) => ({ ...r }))
      .reverse();
  }

  /** The Files ledger across the given accounts, newest first. */
  listAllFilesLedger(accounts: string[]): FilesTransferRecord[] {
    const wanted = new Set(accounts);
    return this.filesTransfers
      .filter((r) => wanted.has(r.accountId))
      .map((r) => ({ ...r }))
      .reverse();
  }

  /**
   * Queue a command for a machine. "start", "desk-end",
   * "view-end", "files-fetch" and "files-push" commands are
   * signed with the machine's secret at queue time, so each
   * exists only because an operator on an account channel queued
   * it; the engine refuses any of them without a valid signature.
   * Undefined when the machine is not enrolled under this account.
   */
  queueHeadlessCommand(
    account: string,
    machineId: string,
    type: string,
    payload: Record<string, unknown>
  ): HeadlessCommand | undefined {
    const rec = this.getHeadlessMachine(account, machineId);
    if (!rec) return undefined;
    const cmd: HeadlessCommand = {
      id: `cmd-${randomBytes(10).toString("hex")}`,
      account,
      machineId,
      type,
      payload,
      createdAt: rfc3339Now(),
      status: "pending"
    };
    if (
      type === "start" ||
      type === "desk-end" ||
      type === "view-end" ||
      type === "files-fetch" ||
      type === "files-push"
    ) {
      cmd.signature = headlessCommandSignature(rec.secret, cmd);
    }
    this.headlessCommands.set(cmd.id, cmd);
    return cmd;
  }

  /**
   * Take (poll) a machine's pending commands: they are returned in
   * queue order and marked delivered, so the pending queue is clear.
   * The records stay for result posting and console reads.
   */
  takeHeadlessCommands(
    account: string,
    machineId: string
  ): Array<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
    signature?: string;
  }> {
    const out: HeadlessCommand[] = [];
    for (const cmd of this.headlessCommands.values()) {
      if (
        cmd.account === account &&
        cmd.machineId === machineId &&
        cmd.status === "pending"
      ) {
        cmd.status = "delivered";
        out.push(cmd);
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return out.map((cmd) => {
      const wire: {
        id: string;
        type: string;
        payload: Record<string, unknown>;
        signature?: string;
      } = { id: cmd.id, type: cmd.type, payload: cmd.payload };
      if (cmd.signature) wire.signature = cmd.signature;
      return wire;
    });
  }

  /** Store a command result posted by the machine that owns it. */
  storeHeadlessResult(
    account: string,
    machineId: string,
    commandId: string,
    result: unknown
  ): boolean {
    const cmd = this.headlessCommands.get(commandId);
    if (!cmd || cmd.account !== account || cmd.machineId !== machineId) {
      return false;
    }
    cmd.result = result;
    cmd.resultAt = rfc3339Now();
    cmd.status = "done";
    // Desk results feed the session ledger: an open raises the
    // live record, an end closes it (always "admin" here: a
    // desk-end command only exists because an operator queued it
    // and the engine verified its signature; an idle end arrives
    // by heartbeat instead). Frames are handled separately below.
    if (cmd.type === "desk-open" || cmd.type === "desk-end") {
      const rec = this.getHeadlessMachine(account, machineId);
      if (rec) {
        const rep =
          typeof result === "object" && result !== null
            ? { ...(result as Record<string, unknown>) }
            : {};
        if (cmd.type === "desk-end" && rep.state === "ended" && !rep.endedBy) {
          rep.endedBy = "admin";
        }
        this.noteDeskReport(rec, rep);
      }
    }
    if (cmd.type === "desk-frame") {
      // A frame result only advances the live record's counter;
      // it can never open or close a session in the ledger.
      const rec = this.getHeadlessMachine(account, machineId);
      const cur = rec?.deskSession;
      if (rec && cur && cur.state === "live") {
        const frames = (result as { framesServed?: unknown } | null)
          ?.framesServed;
        if (typeof frames === "number" && frames > cur.framesServed) {
          cur.framesServed = Math.floor(frames);
        }
      }
    }
    // View results feed the view ledger exactly the way desk
    // results feed the desk ledger, independently of it.
    if (cmd.type === "view-open" || cmd.type === "view-end") {
      const rec = this.getHeadlessMachine(account, machineId);
      if (rec) {
        const rep =
          typeof result === "object" && result !== null
            ? { ...(result as Record<string, unknown>) }
            : {};
        if (cmd.type === "view-end" && rep.state === "ended" && !rep.endedBy) {
          rep.endedBy = "admin";
        }
        this.noteViewReport(rec, rep);
      }
    }
    if (cmd.type === "view-frame") {
      const rec = this.getHeadlessMachine(account, machineId);
      const cur = rec?.viewSession;
      if (rec && cur && cur.state === "live") {
        const frames = (result as { framesServed?: unknown } | null)
          ?.framesServed;
        if (typeof frames === "number" && frames > cur.framesServed) {
          cur.framesServed = Math.floor(frames);
        }
      }
    }
    // Files results feed the transfer ledger: a files-fetch or
    // files-push result carrying a "transfers" array folds each
    // entry into the account's ledger (see noteFilesTransfers).
    if (cmd.type === "files-fetch" || cmd.type === "files-push") {
      const transfers = (result as { transfers?: unknown } | null)
        ?.transfers;
      if (Array.isArray(transfers)) {
        this.noteFilesTransfers(account, machineId, transfers);
      }
    }
    return true;
  }

  getHeadlessCommand(
    account: string,
    commandId: string
  ): HeadlessCommand | undefined {
    const cmd = this.headlessCommands.get(commandId);
    if (!cmd || cmd.account !== account) return undefined;
    return cmd;
  }

  // -----------------------------------------------------------------
  // Moves
  // -----------------------------------------------------------------

  private moveDir(account: string, moveId: string): string {
    return path.join(this.config.dataDir, account, moveId);
  }

  async moveExists(account: string, moveId: string): Promise<boolean> {
    try {
      await fs.stat(path.join(this.moveDir(account, moveId), "meta.json"));
      return true;
    } catch {
      return false;
    }
  }

  async announce(
    account: string,
    moverName: string,
    manifest: Record<string, unknown>
  ): Promise<MoveMeta> {
    const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
    const meta: MoveMeta = {
      moveId: String(manifest.moveId),
      account,
      moverName: typeof moverName === "string" ? moverName : "",
      name: typeof manifest.name === "string" ? manifest.name : "",
      totalBytes:
        typeof manifest.totalBytes === "number" ? manifest.totalBytes : 0,
      totalFiles:
        typeof manifest.totalFiles === "number" ? manifest.totalFiles : 0,
      chunks: chunks.length,
      status: "announced",
      createdAt: rfc3339Now()
    };
    const dir = this.moveDir(account, meta.moveId);
    await fs.mkdir(path.join(dir, "chunks"), { recursive: true });
    await writeFileJSON(path.join(dir, "manifest.json"), manifest);
    await writeFileJSON(path.join(dir, "meta.json"), meta);
    return meta;
  }

  async listMoves(account: string): Promise<MoveMeta[]> {
    const accDir = path.join(this.config.dataDir, account);
    let entries;
    try {
      entries = await fs.readdir(accDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: MoveMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readFileJSON<MoveMeta>(
        path.join(accDir, entry.name, "meta.json")
      );
      if (meta) out.push(meta);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return out;
  }

  async getManifest(
    account: string,
    moveId: string
  ): Promise<Record<string, unknown> | undefined> {
    return readFileJSON<Record<string, unknown>>(
      path.join(this.moveDir(account, moveId), "manifest.json")
    );
  }

  async getMeta(
    account: string,
    moveId: string
  ): Promise<MoveMeta | undefined> {
    return readFileJSON<MoveMeta>(
      path.join(this.moveDir(account, moveId), "meta.json")
    );
  }

  async setStatus(
    account: string,
    moveId: string,
    status: string
  ): Promise<MoveMeta | undefined> {
    const meta = await this.getMeta(account, moveId);
    if (!meta) return undefined;
    meta.status = status;
    await writeFileJSON(
      path.join(this.moveDir(account, moveId), "meta.json"),
      meta
    );
    return meta;
  }

  // -----------------------------------------------------------------
  // Sealed chunks (store-and-forward relay)
  // -----------------------------------------------------------------

  async listPresentChunks(
    account: string,
    moveId: string
  ): Promise<number[]> {
    const chunksDir = path.join(this.moveDir(account, moveId), "chunks");
    let entries;
    try {
      entries = await fs.readdir(chunksDir);
    } catch {
      return [];
    }
    const present: number[] = [];
    for (const name of entries) {
      // Plain integer names only — in-flight "<n>.tmp" writes are skipped.
      if (/^\d+$/.test(name)) present.push(Number(name));
    }
    present.sort((a, b) => a - b);
    return present;
  }

  async putChunk(
    account: string,
    moveId: string,
    n: number,
    sealed: Buffer
  ): Promise<void> {
    const chunksDir = path.join(this.moveDir(account, moveId), "chunks");
    await fs.mkdir(chunksDir, { recursive: true });
    const target = path.join(chunksDir, String(n));
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, sealed);
    await fs.rename(tmp, target);
  }

  async getChunk(
    account: string,
    moveId: string,
    n: number
  ): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(
        path.join(this.moveDir(account, moveId), "chunks", String(n))
      );
    } catch {
      return undefined;
    }
  }

  // -----------------------------------------------------------------
  // Retention
  // -----------------------------------------------------------------

  private async sweepExpired(): Promise<void> {
    const cutoff = Date.now() - this.config.retentionHours * 60 * 60 * 1000;
    let accounts;
    try {
      accounts = await fs.readdir(this.config.dataDir, {
        withFileTypes: true
      });
    } catch {
      return;
    }
    for (const acc of accounts) {
      if (!acc.isDirectory()) continue;
      const accDir = path.join(this.config.dataDir, acc.name);
      let moves;
      try {
        moves = await fs.readdir(accDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const mv of moves) {
        if (!mv.isDirectory()) continue;
        const dir = path.join(accDir, mv.name);
        try {
          const info = await fs.stat(dir);
          if (info.mtimeMs < cutoff) {
            await fs.rm(dir, { recursive: true, force: true });
          }
        } catch {
          // Raced with a writer or a previous sweep — next round retries.
        }
      }
    }
  }
}
