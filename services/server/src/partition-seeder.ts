// =========================================================================
// RELAYN: Partition seeder (server-held pull plan, TypeScript)
// -------------------------------------------------------------------------
// BASE: build stamp 202610281848 (local Grok edits on a03f83d).
//
// The seeder is the SERVER-HELD plan that fills a catalog's waiting pieces
// with bytes. Unlike the old Viewer-local partition_autopull.go plan
// (doc 22, now FALLBACK), this plan lives on the server so a closed Viewer
// does not stop background seeding while the Host stays awake.
//
// SCHEDULE (same priority spine as auto-pull):
//   1. SHELL SET first  -- PARTITION_SHELL_PREFIXES from partition-store
//      (files/Desktop, Start Menu Programs, TaskBar pins, setup/wallpaper).
//   2. then SIZE-ASCENDING over the remaining not-yet-available entries
//      (smallest first, so many names flip to available quickly).
//   3. ON-DEMAND preempt (bump) jumps a path to the FRONT of the queue.
//   4. HOST-AWAKE GATE: when the Host is asleep nothing seeds; the queue
//      and catalog persist, and those rows read `waiting`. Product voice
//      only -- "waiting for the machine" -- never a mechanism word.
//
// THROTTLE (ruled starting shape): 20 paths / ~32 MiB per batch, 1
// concurrent batch per machine.
//
// FENCES (absolute, guard-tested): the seeder queues the signed
// `files-fetch` door ONLY. It never queues files-push and never any
// desk-* command. Source machines stay read-only. Per-file failure is a
// named gap on that catalog entry; the rest of the queue continues.
// =========================================================================

import type {
  PartitionCatalog,
  PartitionCatalogEntry
} from "./partition-catalog.js";
import { isShellPath } from "./partition-catalog.js";
import type { PartitionMutateRecord } from "./partition-store.js";

export const SEEDER_BATCH_MAX_PATHS = 20;
export const SEEDER_BATCH_MAX_BYTES = 32 * 1024 * 1024; // ~32 MiB
export const SEEDER_CONCURRENT_BATCHES = 1;

// The one door the seeder is ever allowed to queue. Guard-pinned: any
// other door (files-push, desk-*) is a bug, not a config.
export const SEEDER_FETCH_DOOR = "files-fetch" as const;

export interface SeederFetchBatch {
  door: typeof SEEDER_FETCH_DOOR; // ALWAYS files-fetch
  paths: string[];
  bytes: number;
}

export interface SeederPlan {
  machineId: string;
  hostAwake: boolean;
  // Ordered pack paths the seeder would fetch (front-of-queue first).
  queue: string[];
  batches: SeederFetchBatch[];
  // The rows the UI should paint, with the three-state vocabulary.
  state: "seeding" | "waiting" | "idle";
  pending: number; // not-yet-available catalog entries
  onDemand: string[]; // paths bumped to the front
  throttle: {
    pathsPerBatch: number;
    bytesPerBatch: number;
    concurrentBatches: number;
  };
}

/**
 * Order the not-yet-available entries: shell set first (in their listed
 * order), then everything else size-ascending. Stable, deterministic, no
 * timers: a pure projection over the catalog so it is trivially testable
 * and safe to recompute on demand.
 */
function orderEntries(entries: PartitionCatalogEntry[]): PartitionCatalogEntry[] {
  const pending = entries.filter((e) => e.availability !== "available");
  const shell = pending.filter((e) => isShellPath(e.packPath));
  const rest = pending.filter((e) => !isShellPath(e.packPath));
  shell.sort((a, b) => {
    if (a.size !== b.size) return a.size - b.size;
    return a.packPath.localeCompare(b.packPath);
  });
  rest.sort((a, b) => {
    if (a.size !== b.size) return a.size - b.size;
    return a.packPath.localeCompare(b.packPath);
  });
  return [...shell, ...rest];
}

function batchify(
  ordered: PartitionCatalogEntry[]
): SeederFetchBatch[] {
  const batches: SeederFetchBatch[] = [];
  let cur: SeederFetchBatch = { door: SEEDER_FETCH_DOOR, paths: [], bytes: 0 };
  for (const e of ordered) {
    const wouldPaths = cur.paths.length + 1;
    const wouldBytes = cur.bytes + Math.max(0, e.size);
    if (
      cur.paths.length > 0 &&
      (wouldPaths > SEEDER_BATCH_MAX_PATHS ||
        wouldBytes > SEEDER_BATCH_MAX_BYTES)
    ) {
      batches.push(cur);
      cur = { door: SEEDER_FETCH_DOOR, paths: [], bytes: 0 };
    }
    cur.paths.push(e.packPath);
    cur.bytes += Math.max(0, e.size);
  }
  if (cur.paths.length > 0) batches.push(cur);
  return batches;
}

export class PartitionSeeder {
  // account|machineId -> paths the operator bumped to the front.
  private onDemand = new Map<string, Set<string>>();

  constructor(private readonly catalog: PartitionCatalog) {}

  private key(account: string, machineId: string): string {
    return account + "|" + machineId;
  }

  /**
   * On-demand preempt: jump a path to the FRONT of the seeder queue. The
   * caller passes whether the Host is awake. Awake -> the row seeds now
   * (marked seeding); asleep -> the row stays waiting and is queued first
   * for the next wake. Returns the row's new availability word.
   */
  async bump(
    account: string,
    machineId: string,
    packPath: string,
    hostAwake: boolean,
    ledger: PartitionMutateRecord[]
  ): Promise<{ state: "seeding" | "waiting" | "available" | "unknown" }> {
    const entry = await this.catalog.queryByPath(account, machineId, packPath);
    if (!entry) return { state: "unknown" };
    if (entry.availability === "available") return { state: "available" };
    let set = this.onDemand.get(this.key(account, machineId));
    if (!set) {
      set = new Set<string>();
      this.onDemand.set(this.key(account, machineId), set);
    }
    set.add(packPath);
    if (hostAwake) {
      await this.catalog.markSeeding(account, machineId, packPath);
      return { state: "seeding" };
    }
    // Asleep: enqueue first for next wake; do not pretend content exists.
    return { state: "waiting" };
  }

  /** Clear an on-demand bump once the path is available (or dropped). */
  clearBump(account: string, machineId: string, packPath: string): void {
    this.onDemand.get(this.key(account, machineId))?.delete(packPath);
  }

  /**
   * Build the current plan: shell-first then size-ascending, on-demand
   * paths pulled to the front, batched at the ruled throttle. Pure over
   * the catalog + awake gate; no side effects on the catalog here (bump()
   * and the catalog own state changes).
   */
  async plan(
    account: string,
    machineId: string,
    hostAwake: boolean,
    ledger: PartitionMutateRecord[]
  ): Promise<SeederPlan> {
    const entries = await this.catalog.liveEntries(account, machineId, ledger);
    const ordered = orderEntries(entries);
    const bumps = this.onDemand.get(this.key(account, machineId)) || new Set();
    // Pull on-demand paths to the front, preserving their order of the
    // ordered projection among themselves.
    const front: PartitionCatalogEntry[] = [];
    const back: PartitionCatalogEntry[] = [];
    for (const e of ordered) {
      if (bumps.has(e.packPath)) front.push(e);
      else back.push(e);
    }
    const finalOrder = [...front, ...back];
    const batches = batchify(finalOrder);
    const pending = finalOrder.length;
    let state: SeederPlan["state"];
    if (pending === 0) state = "idle";
    else state = hostAwake ? "seeding" : "waiting";
    return {
      machineId,
      hostAwake,
      // When asleep nothing actually seeds; the queue is what WOULD seed
      // on the next wake. We still report it so the UI can show waiting
      // rows and the operator can see the plan.
      queue: hostAwake ? finalOrder.map((e) => e.packPath) : [],
      batches: hostAwake ? batches : [],
      state,
      pending,
      onDemand: finalOrder
        .filter((e) => bumps.has(e.packPath))
        .map((e) => e.packPath),
      throttle: {
        pathsPerBatch: SEEDER_BATCH_MAX_PATHS,
        bytesPerBatch: SEEDER_BATCH_MAX_BYTES,
        concurrentBatches: SEEDER_CONCURRENT_BATCHES
      }
    };
  }

  shutdown(): void {
    this.onDemand.clear();
  }
}
