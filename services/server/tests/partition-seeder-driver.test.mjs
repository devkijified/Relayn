// =========================================================================
// Relayn Partition seeder driver GUARD TESTS.
// Run:  node node_modules/tsx/dist/cli.mjs tests/partition-seeder-driver.test.mjs
//
// The driver is the server background engine that executes the
// seeder plan (seed / confirm / probe). Named guards:
//   1. awake gate      -- offline machines get nothing queued.
//   2. concurrency room-- files-fetch queues stop at
//      SEEDER_CONCURRENT_BATCHES minus what is already in flight.
//   3. fence           -- the driver queues files-fetch and the
//      unsigned files-browse ONLY. Never files-push, never desk-*,
//      never view-*.
//   4. probe           -- a capped browse walk merges new files
//      into the catalog, on cadence, one walk at a time.
//   5. confirm         -- a change in the account's sealed-move
//      count rebuilds the online machines' Partition views.
//   6. manual probe    -- requestProbe (Check now) forces a walk
//      before the cadence; a repeat while walking returns
//      "already" and queues nothing extra; once the walk ends
//      the cadence rule applies again.
// =========================================================================

import {
  PartitionSeederDriver,
  SEEDER_PROBE_EVERY_MS
} from "../src/partition-seeder-driver.ts";
import { SEEDER_CONCURRENT_BATCHES } from "../src/partition-seeder.ts";

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log("PASS", name);
  } else {
    failed++;
    console.log("FAIL", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

function makeWorld() {
  const S = {
    machines: [], // {account, view:{machineId, name, online}}
    moves: [],
    planBatches: [],
    queued: [], // every command the driver queued
    commands: new Map(),
    cmdN: 0,
    seeding: [], // markSeeding packPaths
    merged: [], // mergeHostCatalog entry lists
    rebuilds: [] // rebuildFromSealedMoves machineIds
  };
  const moverStore = {
    listAllHeadlessMachines: () => S.machines,
    listMoves: async () => S.moves,
    countActiveHeadlessCommands: (a, m, t) =>
      S.queued.filter(
        (c) => c.account === a && c.machineId === m && c.type === t && c.status !== "done"
      ).length,
    queueHeadlessCommand: async (account, machineId, type, payload) => {
      const cmd = {
        id: "cmd-" + ++S.cmdN,
        account,
        machineId,
        type,
        payload,
        status: "pending"
      };
      S.commands.set(cmd.id, cmd);
      S.queued.push(cmd);
      return cmd;
    },
    getHeadlessCommand: (account, id) => S.commands.get(id)
  };
  const catalog = {
    markSeeding: async (a, m, p) => {
      S.seeding.push(p);
    },
    mergeHostCatalog: async (a, m, entries) => {
      S.merged.push(entries);
    }
  };
  const seeder = {
    plan: async () => ({
      machineId: "m",
      hostAwake: true,
      queue: S.planBatches.flatMap((b) => b.paths),
      batches: S.planBatches,
      state: "seeding",
      pending: S.planBatches.length,
      onDemand: []
    })
  };
  const partitionStore = {
    listLedger: async () => [],
    rebuildFromSealedMoves: async (a, m) => {
      S.rebuilds.push(m);
    }
  };
  const driver = new PartitionSeederDriver({
    moverStore,
    catalog,
    seeder,
    partitionStore
  });
  return { S, driver };
}

function onlineMachine(S, id) {
  S.machines = [
    { account: "acct1", view: { machineId: id, name: id, online: true } }
  ];
}
function batchOf(...paths) {
  return { door: "files-fetch", paths, bytes: paths.length };
}
function finishBrowse(S, cmdId, result) {
  const cmd = S.commands.get(cmdId);
  cmd.status = "done";
  cmd.result = result;
}

// 1 + 2 + 3: awake gate, concurrency room, fence.
{
  const { S, driver } = makeWorld();
  S.machines = [
    { account: "acct1", view: { machineId: "off1", name: "off1", online: false } }
  ];
  S.planBatches = [batchOf("files/Desktop/a.txt")];
  await driver.tick(0);
  check("offline machine gets nothing queued", S.queued.length === 0, S.queued);

  onlineMachine(S, "m1");
  S.planBatches = [
    batchOf("files/Desktop/a.txt"),
    batchOf("files/Desktop/b.txt"),
    batchOf("files/Desktop/c.txt"),
    batchOf("files/Desktop/d.txt"),
    batchOf("files/Desktop/e.txt")
  ];
  await driver.tick(0);
  const fetches = S.queued.filter((c) => c.type === "files-fetch");
  check(
    "driver queues up to the concurrency room",
    fetches.length === SEEDER_CONCURRENT_BATCHES,
    fetches.length
  );
  check(
    "queued batches carry the plan paths in order",
    fetches[0].payload.paths.join() === "files/Desktop/a.txt" &&
      fetches[2].payload.paths.join() === "files/Desktop/c.txt",
    fetches.map((f) => f.payload)
  );
  check(
    "seeded paths are marked seeding",
    S.seeding.join() ===
      "files/Desktop/a.txt,files/Desktop/b.txt,files/Desktop/c.txt",
    S.seeding
  );
  await driver.tick(1000);
  check(
    "a full room queues nothing more",
    S.queued.filter((c) => c.type === "files-fetch").length ===
      SEEDER_CONCURRENT_BATCHES,
    S.queued.length
  );
  for (const c of S.queued) c.status = "done";
  // Landed fetches confirm their entries available, so the
  // plan the seeder returns next holds only what is left.
  S.planBatches = [batchOf("files/Desktop/d.txt"), batchOf("files/Desktop/e.txt")];
  await driver.tick(2000);
  check(
    "landed fetches free the room for the next batches",
    S.queued.filter((c) => c.type === "files-fetch").length ===
      SEEDER_CONCURRENT_BATCHES + 2,
    S.queued.length
  );
}

// 4: the probe walk merges new files, on cadence.
{
  const { S, driver } = makeWorld();
  onlineMachine(S, "m2");
  const T0 = 1_000_000_000_000; // realistic epoch: the first pass probes
  await driver.tick(T0);
  const browses1 = S.queued.filter((c) => c.type === "files-browse");
  check(
    "probe starts with root browses in flight (capped at 2)",
    browses1.length === 2 &&
      browses1[0].payload.prefix === "files/Desktop" &&
      browses1[1].payload.prefix === "files/Documents",
    browses1.map((b) => b.payload)
  );
  finishBrowse(S, browses1[0].id, {
    prefix: "files/Desktop",
    total: 2,
    offset: 0,
    children: [
      {
        kind: "file",
        path: "files/Desktop/new.txt",
        size: 42,
        modTime: "2026-10-31T00:00:00.000Z"
      },
      { kind: "folder", path: "files/Desktop/Sub" }
    ]
  });
  finishBrowse(S, browses1[1].id, { prefix: "files/Documents", total: 0, offset: 0, children: [] });
  await driver.tick(T0 + 1000);
  // Drain the walk: keep finishing whatever is queued until it ends.
  for (let i = 0; i < 30 && S.merged.length === 0; i++) {
    for (const c of S.queued.filter(
      (c) => c.type === "files-browse" && c.status !== "done"
    )) {
      finishBrowse(S, c.id, {
        prefix: c.payload.prefix,
        total: 0,
        offset: 0,
        children: []
      });
    }
    await driver.tick(T0 + 1000 + i);
  }
  check(
    "the walk merges the discovered file into the catalog",
    S.merged.length === 1 &&
      S.merged[0].length === 1 &&
      S.merged[0][0].packPath === "files/Desktop/new.txt" &&
      S.merged[0][0].size === 42 &&
      S.merged[0][0].modTime === Date.parse("2026-10-31T00:00:00.000Z"),
    S.merged
  );
  const browsesBefore = S.queued.filter((c) => c.type === "files-browse").length;
  await driver.tick(T0 + SEEDER_PROBE_EVERY_MS);
  check(
    "no new probe before the cadence",
    S.queued.filter((c) => c.type === "files-browse").length === browsesBefore,
    browsesBefore
  );
  await driver.tick(T0 + 2 * SEEDER_PROBE_EVERY_MS);
  check(
    "a new probe starts after the cadence",
    S.queued.filter((c) => c.type === "files-browse").length > browsesBefore
  );
}

// 5: confirm on landed moves.
{
  const { S, driver } = makeWorld();
  onlineMachine(S, "m3");
  S.moves = [{ id: "mv1" }];
  await driver.tick(0);
  check("first pass records the move count, no rebuild", S.rebuilds.length === 0);
  await driver.tick(1000);
  check("unchanged moves, still no rebuild", S.rebuilds.length === 0);
  S.moves = [{ id: "mv1" }, { id: "mv2" }];
  await driver.tick(2000);
  check(
    "a landed move rebuilds the machine view",
    S.rebuilds.join() === "m3",
    S.rebuilds
  );
}

// 6: manual Check now forces a probe before the cadence.
{
  const { S, driver } = makeWorld();
  onlineMachine(S, "m5");
  const browseCount = () =>
    S.queued.filter((c) => c.type === "files-browse").length;
  async function drainWalk(now0) {
    for (let i = 0; i < 40 && driver.isProbing("acct1", "m5"); i++) {
      for (const c of S.queued.filter(
        (c) => c.type === "files-browse" && c.status !== "done"
      )) {
        finishBrowse(S, c.id, {
          prefix: c.payload.prefix,
          total: 0,
          offset: 0,
          children: []
        });
      }
      await driver.tick(now0 + i);
    }
  }
  const T0 = 1_000_000_000_000;
  await driver.tick(T0); // the scheduled walk starts on cadence
  check(
    "scheduled walk is probing",
    driver.isProbing("acct1", "m5") && browseCount() === 2,
    browseCount()
  );
  await drainWalk(T0 + 1000);
  check("drained walk is no longer probing", !driver.isProbing("acct1", "m5"));

  const settled = browseCount();
  await driver.tick(T0 + 61_000); // a minute later: cadence still rules
  check(
    "cadence holds after the scheduled walk",
    browseCount() === settled,
    browseCount()
  );

  const first = driver.requestProbe("acct1", "m5");
  check("requestProbe returns started", first === "started", first);
  await driver.tick(T0 + 62_000);
  check(
    "requestProbe before cadence starts a walk on the next tick",
    driver.isProbing("acct1", "m5") && browseCount() === settled + 2,
    browseCount()
  );
  const second = driver.requestProbe("acct1", "m5");
  check("requestProbe while walking returns already", second === "already", second);
  await driver.tick(T0 + 63_000);
  check(
    "a second requestProbe queues nothing extra",
    browseCount() === settled + 2,
    browseCount()
  );
  await drainWalk(T0 + 64_000);
  const afterManual = browseCount();
  await driver.tick(T0 + 125_000); // still well inside the cadence
  check(
    "after the manual walk completes the cadence rule applies again",
    browseCount() === afterManual,
    browseCount()
  );
}

// 3 (global): nothing but the two doors was ever queued anywhere.
{
  const { S, driver } = makeWorld();
  onlineMachine(S, "m4");
  S.planBatches = [batchOf("files/Desktop/x.txt")];
  await driver.tick(0);
  const types = new Set(S.queued.map((c) => c.type));
  check(
    "driver queues files-fetch and files-browse only",
    [...types].every((t) => t === "files-fetch" || t === "files-browse"),
    [...types]
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
