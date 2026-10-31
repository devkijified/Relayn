// =========================================================================
// RELAYN: Partition seeder driver (server background engine)
// -------------------------------------------------------------------------
// The seeder (partition-seeder.ts) is a PLAN: an ordered projection of
// what should be fetched next. Until this driver existed, nothing on
// the server executed the plan on its own: seeding advanced only
// while an Admin Viewer or console session was open to drive it.
// A backup product cannot work that way, so this driver executes
// the plan from the server, on a timer, while the Host is awake:
//
//   1. SEED: for every online machine, take the plan, respect the
//      concurrency room (SEEDER_CONCURRENT_BATCHES minus the
//      files-fetch commands already in flight for that machine),
//      mark the batch's entries seeding, and queue the batch
//      through the ONE signed lane (MoverStore.queueHeadlessCommand
//      with type files-fetch). The driver never queues any other
//      door: no files-push, no desk-*, no view-*. Source machines
//      stay read-only.
//   2. CONFIRM: when an account's sealed-move count changes (a
//      fetch landed), rebuild the machine's Partition view; the
//      rebuild confirms catalog availability from the file refs,
//      the same path the rebuild route uses.
//   3. PROBE: on a slow cadence per machine, walk the machine's
//      inventory roots with the unsigned files-browse door and
//      merge what is found into the catalog (mergeHostCatalog).
//      This is how the catalog learns about NEW files the machine
//      gained since the last look, without anyone opening a
//      Partition. The walk is breadth-first, capped in commands
//      and entries, and treats a missing root as absent, not as
//      an error.
//
// Everything here is best-effort background work: a failed tick
// logs and the next tick tries again. Nothing the driver does is
// allowed to fail a request or block boot.
// =========================================================================

import type { MoverStore } from "./mover-store.js";
import type { PartitionCatalog } from "./partition-catalog.js";
import {
  PartitionSeeder,
  SEEDER_CONCURRENT_BATCHES,
  SEEDER_FETCH_DOOR
} from "./partition-seeder.js";
import type { PartitionStore } from "./partition-store.js";

export const SEEDER_DRIVER_TICK_MS = 15_000;
export const SEEDER_PROBE_EVERY_MS = 30 * 60_000; // per machine
export const SEEDER_PROBE_MAX_COMMANDS = 400;
export const SEEDER_PROBE_MAX_ENTRIES = 20_000;
export const SEEDER_PROBE_PAGE = 200;

// The inventory roots the probe walks, in packPath form. A root
// the machine does not have answers with an error result and is
// skipped; that is a normal shape (not every profile carries
// every known folder).
export const SEEDER_PROBE_ROOTS = [
  "files/Desktop",
  "files/Documents",
  "files/Downloads",
  "files/Pictures",
  "files/Music",
  "files/Videos"
];

interface ProbePage {
  prefix: string;
  offset: number;
}

interface ProbeWalk {
  startedAt: number;
  queue: ProbePage[]; // pages still to browse
  out: Map<string, ProbePage>; // command id -> the page it asked for
  entries: Array<{ packPath: string; size: number; modTime: number }>;
  commands: number;
}

export interface SeederDriverDeps {
  moverStore: MoverStore;
  catalog: PartitionCatalog;
  seeder: PartitionSeeder;
  partitionStore: PartitionStore;
}

export class PartitionSeederDriver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private moveCounts = new Map<string, number>(); // account -> moves seen
  private lastProbeAt = new Map<string, number>(); // account|machine -> ms
  private walks = new Map<string, ProbeWalk>();
  private forceProbe = new Set<string>(); // account|machine keys a manual Check now armed

  constructor(private readonly deps: SeederDriverDeps) {}

  /** Manual probe trigger (the Backup door's Check now). Forces a
   * probe walk for the machine on the next tick, cadence or not.
   * Returns "already" when a walk for the machine is in progress
   * (nothing extra is queued), otherwise "started": the cadence
   * stamp is cleared and the force flag armed, and the next tick
   * that sees the machine online begins the walk. */
  requestProbe(account: string, machineId: string): "started" | "already" {
    const key = account + "|" + machineId;
    if (this.walks.has(key)) return "already";
    this.lastProbeAt.delete(key);
    this.forceProbe.add(key);
    return "started";
  }

  /** True while a probe walk for the machine is in progress. */
  isProbing(account: string, machineId: string): boolean {
    return this.walks.has(account + "|" + machineId);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, SEEDER_DRIVER_TICK_MS);
    // Node-only unref: the driver never keeps the process alive.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One driver pass over every enrolled machine. Public for
   * tests; the timer calls it on SEEDER_DRIVER_TICK_MS. */
  async tick(now: number = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const machines = this.deps.moverStore.listAllHeadlessMachines();
      const accounts = new Map<string, number>();
      for (const { account, view } of machines) {
        if (!accounts.has(account)) {
          const moves = await this.deps.moverStore.listMoves(account);
          accounts.set(account, moves.length);
        }
        if (!view.online) continue;
        await this.confirmFromMoves(account, view.machineId, view.name, accounts.get(account) ?? 0);
        await this.seedMachine(account, view.machineId);
        await this.probeMachine(account, view.machineId, now);
      }
    } catch (err) {
      console.error("[relayn] seeder driver tick failed:", err);
    } finally {
      this.ticking = false;
    }
  }

  // When the account's sealed moves grew since the last pass, a
  // fetch has landed: rebuild this machine's Partition view,
  // which confirms catalog availability from the new file refs.
  private async confirmFromMoves(
    account: string,
    machineId: string,
    machineName: string,
    moveCount: number
  ): Promise<void> {
    const seen = this.moveCounts.get(account);
    this.moveCounts.set(account, moveCount);
    if (seen === undefined || seen === moveCount) return;
    await this.deps.partitionStore.rebuildFromSealedMoves(
      account,
      machineId,
      machineName
    );
  }

  // Queue plan batches while the machine has concurrency room.
  private async seedMachine(account: string, machineId: string): Promise<void> {
    const inFlight = this.deps.moverStore.countActiveHeadlessCommands(
      account,
      machineId,
      SEEDER_FETCH_DOOR
    );
    let room = SEEDER_CONCURRENT_BATCHES - inFlight;
    if (room <= 0) return;
    const ledger = await this.deps.partitionStore.listLedger(account, machineId);
    const plan = await this.deps.seeder.plan(account, machineId, true, ledger);
    for (const batch of plan.batches) {
      if (room <= 0) break;
      for (const packPath of batch.paths) {
        await this.deps.catalog.markSeeding(account, machineId, packPath);
      }
      const cmd = await this.deps.moverStore.queueHeadlessCommand(
        account,
        machineId,
        SEEDER_FETCH_DOOR,
        { paths: batch.paths }
      );
      if (cmd) room--;
    }
  }

  // The probe: a capped breadth-first files-browse walk whose
  // files merge into the catalog. Runs at most one walk per
  // machine at a time, on SEEDER_PROBE_EVERY_MS cadence.
  private async probeMachine(
    account: string,
    machineId: string,
    now: number
  ): Promise<void> {
    const key = account + "|" + machineId;
    let walk = this.walks.get(key);
    if (!walk) {
      // A manual Check now (requestProbe) starts the walk at once,
      // whatever the cadence says; the flag is consumed here.
      const forced = this.forceProbe.delete(key);
      const last = this.lastProbeAt.get(key) ?? 0;
      if (!forced && now - last < SEEDER_PROBE_EVERY_MS) return;
      walk = {
        startedAt: now,
        queue: SEEDER_PROBE_ROOTS.map((prefix) => ({ prefix, offset: 0 })),
        out: new Map(),
        entries: [],
        commands: 0
      };
      this.walks.set(key, walk);
    }

    // Fold in any results that have landed since the last pass.
    for (const [cmdId, pageReq] of [...walk.out]) {
      const cmd = this.deps.moverStore.getHeadlessCommand(account, cmdId);
      if (!cmd || cmd.status !== "done") continue;
      walk.out.delete(cmdId);
      this.foldBrowseResult(walk, pageReq, cmd.result);
    }

    // Queue the next browses while there is room and budget.
    while (
      walk.queue.length > 0 &&
      walk.out.size < 2 &&
      walk.commands < SEEDER_PROBE_MAX_COMMANDS
    ) {
      const pageReq = walk.queue.shift() as ProbePage;
      const cmd = await this.deps.moverStore.queueHeadlessCommand(
        account,
        machineId,
        "files-browse",
        {
          prefix: pageReq.prefix,
          offset: pageReq.offset,
          limit: SEEDER_PROBE_PAGE
        }
      );
      if (!cmd) break;
      walk.out.set(cmd.id, pageReq);
      walk.commands++;
    }

    // Walk over: merge what was found and stamp the cadence.
    if (walk.queue.length === 0 && walk.out.size === 0) {
      this.walks.delete(key);
      this.lastProbeAt.set(key, now);
      if (walk.entries.length > 0) {
        await this.deps.catalog.mergeHostCatalog(
          account,
          machineId,
          walk.entries
        );
      }
    }
  }

  // One browse page into the walk: files become catalog
  // entries, folders join the walk queue, and a level with
  // more children than the page held queues its continuation.
  private foldBrowseResult(
    walk: ProbeWalk,
    pageReq: ProbePage,
    result: unknown
  ): void {
    const page = result as {
      total?: number;
      offset?: number;
      children?: Array<{
        kind?: string;
        path?: string;
        size?: number;
        modTime?: string;
      }>;
    } | null;
    if (!page || !Array.isArray(page.children)) return; // absent root etc.
    for (const child of page.children) {
      if (!child.path) continue;
      if (child.kind === "folder") {
        walk.queue.push({ prefix: child.path, offset: 0 });
      } else if (child.kind === "file") {
        if (walk.entries.length >= SEEDER_PROBE_MAX_ENTRIES) continue;
        walk.entries.push({
          packPath: child.path,
          size: typeof child.size === "number" ? child.size : 0,
          modTime: child.modTime ? Date.parse(child.modTime) || 0 : 0
        });
      }
    }
    const total = typeof page.total === "number" ? page.total : 0;
    const offset = typeof page.offset === "number" ? page.offset : pageReq.offset;
    if (offset + page.children.length < total) {
      walk.queue.push({
        prefix: pageReq.prefix,
        offset: offset + page.children.length
      });
    }
  }
}
