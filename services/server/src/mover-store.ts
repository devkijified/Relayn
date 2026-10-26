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
