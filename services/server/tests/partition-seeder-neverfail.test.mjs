// =========================================================================
// Relayn Partition seeder NEVER-FAIL GUARD TESTS (owner order
// 2026-11-05: "browser should never fail and that's the whole
// point").
// Run:  node node_modules/tsx/dist/cli.mjs tests/partition-seeder-neverfail.test.mjs
//
// The server half of the never-fail contract, pinned end to end
// with the REAL catalog, seeder and driver over a fake machine:
//
//   1. fails twice, then lands -- a browser piece whose transfer
//      dies twice is requeued ON ITS OWN (no bump, no press, no
//      owner action of any kind) and ends available, its attempt
//      accounting cleared by the landing.
//   2. no seeding limbo -- a fetch that finishes without landing
//      a piece never leaves that piece in `seeding`: it returns
//      to waiting with a named gap and a counted attempt.
//   3. permanently unreadable -- a browser piece that can never
//      be read spends its attempt budget and ends as a NAMED
//      final gap on its catalog entry while the rest of the
//      browser tier (and the shell behind it) completes.
//   4. backoff -- a failed piece is not requeued before its
//      backoff elapses, is requeued after it, and a bump (fresh
//      intent) outranks the backoff and revives a final gap.
// =========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LocalObjectStorage, StateDocs } from "../src/storage.ts";
import {
  PartitionCatalog,
  PARTITION_BROWSER_ROOT
} from "../src/partition-catalog.ts";
import {
  PartitionSeeder,
  SEEDER_MAX_ATTEMPTS
} from "../src/partition-seeder.ts";
import { PartitionSeederDriver } from "../src/partition-seeder-driver.ts";

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

const ACC = "acctneverfail01";
const MID = "owner-pc";
const UD = PARTITION_BROWSER_ROOT;
const MIN = 60_000;

function freshDir() {
  return mkdtempSync(path.join(tmpdir(), "relayn-neverfail-"));
}

// A world: real catalog + seeder + driver, a fake machine whose
// files-fetch commands the test completes by hand, and a fake
// partition store whose rebuild confirms exactly the pieces the
// test staged as landed (the real store's confirm path).
function makeWorld() {
  const dir = freshDir();
  const catalog = new PartitionCatalog(
    new StateDocs(new LocalObjectStorage(dir))
  );
  const seeder = new PartitionSeeder(catalog);
  const S = {
    commands: new Map(),
    queued: [],
    cmdN: 0,
    moves: [],
    landed: new Set()
  };
  const moverStore = {
    listAllHeadlessMachines: () => [
      { account: ACC, view: { machineId: MID, name: MID, online: true } }
    ],
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
        status: "pending",
        result: undefined
      };
      S.commands.set(cmd.id, cmd);
      S.queued.push(cmd);
      return cmd;
    },
    getHeadlessCommand: (account, id) => S.commands.get(id)
  };
  const partitionStore = {
    listLedger: async () => [],
    rebuildFromSealedMoves: async () => {
      const refs = [];
      for (const p of S.landed) {
        const e = await catalog.queryByPath(ACC, MID, p);
        if (e) {
          refs.push({
            packPath: p,
            size: e.size,
            modTime: e.modTime,
            moveId: "mv-test"
          });
        }
      }
      if (refs.length > 0) {
        await catalog.confirmAvailableFromRefs(ACC, MID, refs);
      }
    }
  };
  const driver = new PartitionSeederDriver({
    moverStore,
    catalog,
    seeder,
    partitionStore
  });
  return { dir, catalog, seeder, driver, S };
}

// Complete the oldest unfinished files-fetch: outcomes maps
// path -> "sent" | failure reason. Sent paths land (a sealed
// move appears, exactly like the real lane).
function completeFetch(S, outcomes) {
  const cmd = S.queued.find((c) => c.type === "files-fetch" && c.status !== "done");
  if (!cmd) throw new Error("no files-fetch in flight to complete");
  const transfers = cmd.payload.paths.map((p) => {
    const o = outcomes[p] || "sent";
    if (o === "sent") {
      S.landed.add(p);
      return { path: p, outcome: "sent" };
    }
    return { path: p, outcome: "failed: " + o };
  });
  if (transfers.some((t) => t.outcome === "sent")) {
    S.moves = [...S.moves, { id: "mv-" + S.moves.length }];
  }
  cmd.status = "done";
  cmd.result = { status: "sent", moveId: "mv-test", transfers };
  return cmd;
}

function fetchesCarrying(S, p) {
  return S.queued.filter(
    (c) => c.type === "files-fetch" && c.payload.paths.includes(p)
  ).length;
}

async function main() {
  // ---- 1 + 2: fails twice, then lands; no seeding limbo --------
  {
    const { dir, catalog, driver, S } = makeWorld();
    const FLAKY = `${UD}/Default/History`;
    const STEADY = `${UD}/Local State`;
    const SHELL = "files/Desktop/a.lnk";
    await catalog.mergeHostCatalog(ACC, MID, [
      { packPath: FLAKY, size: 300, modTime: 1 },
      { packPath: STEADY, size: 100, modTime: 1 },
      { packPath: SHELL, size: 50, modTime: 1 }
    ]);
    const t0 = Date.now();
    await driver.tick(t0);
    check(
      "round 1: the browser payload is queued first",
      S.queued.length > 0 &&
        S.queued[0].type === "files-fetch" &&
        S.queued[0].payload.paths.includes(FLAKY),
      JSON.stringify(S.queued.map((c) => c.payload))
    );
    completeFetch(S, {
      [FLAKY]: "locked by the app holding it",
      [STEADY]: "sent",
      [SHELL]: "sent"
    });
    await driver.tick(t0 + 10 * MIN);
    let e = await catalog.queryByPath(ACC, MID, FLAKY);
    // Limbo would be: seeding with no attempt counted and no
    // fetch in flight. Here the failure is counted and named,
    // and the piece is seeding again only because its retry
    // fetch is genuinely in flight (asserted just below).
    check(
      "after failure 1: the failure is counted, not limbo",
      e.attempts === 1 && typeof e.lastAttemptAt === "string",
      JSON.stringify(e)
    );
    check(
      "after failure 1: the gap names the lane's own reason",
      typeof e.gap === "string" && e.gap.includes("locked by the app holding it"),
      e.gap
    );
    check(
      "after failure 1: the piece was requeued on its own (no press, no bump)",
      fetchesCarrying(S, FLAKY) === 2,
      fetchesCarrying(S, FLAKY)
    );
    const steady = await catalog.queryByPath(ACC, MID, STEADY);
    check(
      "the piece that landed in the same batch is available",
      steady.availability === "available",
      JSON.stringify(steady)
    );
    completeFetch(S, { [FLAKY]: "locked by the app holding it" });
    await driver.tick(t0 + 20 * MIN);
    e = await catalog.queryByPath(ACC, MID, FLAKY);
    check(
      "after failure 2: attempt 2 counted and a third fetch is in flight",
      e.attempts === 2 && fetchesCarrying(S, FLAKY) === 3,
      JSON.stringify({ attempts: e.attempts, fetches: fetchesCarrying(S, FLAKY) })
    );
    completeFetch(S, { [FLAKY]: "sent" });
    await driver.tick(t0 + 30 * MIN);
    e = await catalog.queryByPath(ACC, MID, FLAKY);
    check(
      "third try lands: the piece ends available with no owner action",
      e.availability === "available",
      JSON.stringify(e)
    );
    check(
      "the landing cleared the attempt accounting and the gap",
      e.attempts === undefined && e.gap === undefined && e.gapFinal === undefined,
      JSON.stringify(e)
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- 3: permanently unreadable ends as a named final gap -----
  {
    const { dir, catalog, seeder, driver, S } = makeWorld();
    const BAD = `${UD}/Default/Cookies-journal`;
    const GOOD = `${UD}/Default/Bookmarks`;
    const SHELL = "files/Desktop/b.lnk";
    await catalog.mergeHostCatalog(ACC, MID, [
      { packPath: BAD, size: 10, modTime: 1 },
      { packPath: GOOD, size: 20, modTime: 1 },
      { packPath: SHELL, size: 30, modTime: 1 }
    ]);
    const t0 = Date.now();
    await driver.tick(t0);
    completeFetch(S, {
      [BAD]: "the file is held open and cannot be read",
      [GOOD]: "sent",
      [SHELL]: "sent"
    });
    // Rounds 2..MAX: each tick settles the last failure and,
    // the backoff being minutes behind the tick clock, requeues.
    for (let round = 2; round <= SEEDER_MAX_ATTEMPTS; round++) {
      await driver.tick(t0 + round * 10 * MIN);
      const inFlight = S.queued.find(
        (c) => c.type === "files-fetch" && c.status !== "done"
      );
      if (inFlight) {
        completeFetch(S, { [BAD]: "the file is held open and cannot be read" });
      }
    }
    await driver.tick(t0 + (SEEDER_MAX_ATTEMPTS + 1) * 10 * MIN);
    const bad = await catalog.queryByPath(ACC, MID, BAD);
    check(
      "budget spent: the piece is a NAMED final gap, still in the catalog",
      bad.gapFinal === true &&
        typeof bad.gap === "string" &&
        bad.gap.includes("after " + SEEDER_MAX_ATTEMPTS + " tries") &&
        bad.gap.includes("held open"),
      JSON.stringify(bad)
    );
    check(
      "budget spent: exactly the budget of fetches was tried, no more",
      fetchesCarrying(S, BAD) === SEEDER_MAX_ATTEMPTS,
      fetchesCarrying(S, BAD)
    );
    const good = await catalog.queryByPath(ACC, MID, GOOD);
    const shell = await catalog.queryByPath(ACC, MID, SHELL);
    check(
      "the rest of the browser tier and the shell completed without it",
      good.availability === "available" && shell.availability === "available",
      JSON.stringify({ good: good.availability, shell: shell.availability })
    );
    const plan = await seeder.plan(ACC, MID, true, [], t0 + 100 * MIN);
    check(
      "the plan no longer queues the final gap, and still counts it pending",
      !plan.queue.includes(BAD) && plan.pending === 1,
      JSON.stringify({ queue: plan.queue, pending: plan.pending })
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- 4: backoff spacing, bump outranks it, bump revives ------
  {
    const { dir, catalog, seeder } = makeWorld();
    const P = `${UD}/Default/Sessions/Session_1`;
    await catalog.mergeHostCatalog(ACC, MID, [
      { packPath: P, size: 10, modTime: 1 }
    ]);
    await catalog.markSeeding(ACC, MID, P);
    await catalog.noteSeedFailure(ACC, MID, P, "locked", SEEDER_MAX_ATTEMPTS);
    const settled = await catalog.queryByPath(ACC, MID, P);
    check(
      "no seeding limbo at the catalog: a failed attempt flips seeding back to waiting",
      settled.availability === "waiting" && settled.attempts === 1,
      JSON.stringify(settled)
    );
    const nowPlan = await seeder.plan(ACC, MID, true, [], Date.now());
    check(
      "backoff: a just-failed piece is not requeued at once",
      !nowPlan.queue.includes(P),
      JSON.stringify(nowPlan.queue)
    );
    const laterPlan = await seeder.plan(ACC, MID, true, [], Date.now() + 31_000);
    check(
      "backoff: the piece is requeued once its backoff elapses",
      laterPlan.queue.includes(P),
      JSON.stringify(laterPlan.queue)
    );
    // Spend the whole budget, then revive with a bump.
    for (let i = 1; i < SEEDER_MAX_ATTEMPTS; i++) {
      await catalog.noteSeedFailure(ACC, MID, P, "locked", SEEDER_MAX_ATTEMPTS);
    }
    let e = await catalog.queryByPath(ACC, MID, P);
    check(
      "budget spent at the catalog: gapFinal stands",
      e.gapFinal === true && e.attempts === SEEDER_MAX_ATTEMPTS,
      JSON.stringify(e)
    );
    const deadPlan = await seeder.plan(ACC, MID, true, [], Date.now() + 24 * 60 * MIN);
    check(
      "a final gap never requeues on its own, even a day later",
      !deadPlan.queue.includes(P),
      JSON.stringify(deadPlan.queue)
    );
    await seeder.bump(ACC, MID, P, true, []);
    e = await catalog.queryByPath(ACC, MID, P);
    const revivedPlan = await seeder.plan(ACC, MID, true, [], Date.now());
    check(
      "a bump revives the final gap with a fresh budget and it queues",
      e.gapFinal === undefined &&
        e.attempts === undefined &&
        revivedPlan.queue.includes(P),
      JSON.stringify({ e, queue: revivedPlan.queue })
    );
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
