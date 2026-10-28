// =========================================================================
// Relayn Partition catalog-first (doc 23) GUARD TESTS.
// Run:  node node_modules/tsx/dist/cli.mjs tests/partition-catalog-first.test.mjs
//
// Named guards (APPLY-VERDICT slice-1):
//   1. no-merge listing rule  -- Partition lists from the catalog ONLY,
//      availability on every file row, never a live+catalog mix (ruling A)
//   2. catalog persistence across a restart + never swept (state-class)
//   3. hash-before-available  -- a piece flips to available ONLY after a
//      full SHA-256 verifies during seeding (ruling C)
//   4. expiry-to-waiting with the ledger still winning (ruling F)
//   5. seeder shape -- shell-first then size-ascending, 20 / ~32 MiB / 1
//      concurrent, Host-awake gate, on-demand preempt, files-fetch ONLY
// =========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LocalObjectStorage, StateDocs, isBulkKey } from "../src/storage.ts";
import { PartitionCatalog } from "../src/partition-catalog.ts";
import {
  PartitionSeeder,
  SEEDER_FETCH_DOOR,
  SEEDER_BATCH_MAX_PATHS,
  SEEDER_BATCH_MAX_BYTES
} from "../src/partition-seeder.ts";

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

const ACC = "acctcatalog01";
const MID = "owner-pc";
const SHELL = "files/Desktop";
const TASKBAR =
  "appData/Roaming/Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar";

function freshDir() {
  return mkdtempSync(path.join(tmpdir(), "relayn-catalog-"));
}
function newCatalog(dir) {
  return new PartitionCatalog(new StateDocs(new LocalObjectStorage(dir)));
}

async function main() {
  // ---- GUARD 1: no-merge listing rule (ruling A) --------------------
  {
    const dir = freshDir();
    const cat = newCatalog(dir);
    await cat.mergeHostCatalog(ACC, MID, [
      { packPath: "files/Desktop/Report.docx", size: 100, modTime: 1000 },
      { packPath: "files/Desktop/Projects/plan.txt", size: 7, modTime: 1000 },
      { packPath: "setup/wallpaper/img1.jpg", size: 60, modTime: 900 }
    ]);
    const root = await cat.browse(ACC, MID, "", []);
    check(
      "no-merge: browse is catalog-sourced",
      root.source === "catalog",
      JSON.stringify(root)
    );
    check(
      "no-merge: root lists only catalog categories as dirs, sorted",
      root.children.map((c) => c.kind + ":" + c.name).join(",") ===
        "dir:files,dir:setup",
      JSON.stringify(root.children)
    );
    const desk = await cat.browse(ACC, MID, "files/Desktop", []);
    const report = desk.children.find((c) => c.name === "Report.docx");
    check(
      "no-merge: every file row carries an availability word",
      desk.children
        .filter((c) => c.kind === "file")
        .every((c) => ["available", "seeding", "waiting"].includes(c.availability)),
      JSON.stringify(desk.children)
    );
    check(
      "no-merge: a merged metadata row is waiting (no bytes yet)",
      report && report.availability === "waiting" && report.size === 100,
      JSON.stringify(report)
    );
    check(
      "no-merge: browse shows ONLY paths the catalog holds (no live source)",
      desk.total === 2 && // Report.docx + Projects dir
        !JSON.stringify(desk.children).includes("notInCatalog"),
      JSON.stringify(desk)
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- GUARD 2: persistence across restart + never swept ------------
  {
    const dir = freshDir();
    const cat1 = newCatalog(dir);
    await cat1.confirmAvailableFromRefs(ACC, MID, [
      {
        packPath: "files/Desktop/Report.docx",
        size: 100,
        modTime: 1000,
        moveId: "move-A",
        sha256: "hash-report"
      }
    ]);
    // A brand-new catalog over the SAME disk dir == a server restart
    // (fresh in-memory cache, state read back from the store).
    const cat2 = newCatalog(dir);
    const e = await cat2.queryByPath(ACC, MID, "files/Desktop/Report.docx");
    check(
      "persistence: available entry + moveId survive a restart",
      e &&
        e.availability === "available" &&
        e.moveId === "move-A" &&
        e.hash === "hash-report",
      JSON.stringify(e)
    );
    const key = `${ACC}/_partition/${MID}/catalog.json`;
    check(
      "never swept: catalog key is state-class (isBulkKey false)",
      isBulkKey(key) === false,
      `isBulkKey(${key})=${isBulkKey(key)}`
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- GUARD 3: hash-before-available (ruling C) --------------------
  {
    const dir = freshDir();
    const cat = newCatalog(dir);
    await cat.mergeHostCatalog(ACC, MID, [
      { packPath: "files/Desktop/a.txt", size: 10, modTime: 1 },
      { packPath: "files/Desktop/b.txt", size: 20, modTime: 1, hash: "known-b" }
    ]);
    // No verified hash -> never available, stays seeding.
    const r1 = await cat.applySeedResult(ACC, MID, "files/Desktop/a.txt", {
      moveId: "move-a"
    });
    const a1 = await cat.queryByPath(ACC, MID, "files/Desktop/a.txt");
    check(
      "hash-gate: no verified hash never flips available",
      r1 === false && a1.availability === "seeding" && a1.moveId === undefined,
      JSON.stringify({ r1, a1 })
    );
    // Verified hash present -> available + moveId + lastUsedAt.
    const r2 = await cat.applySeedResult(ACC, MID, "files/Desktop/a.txt", {
      verifiedHash: "verified-a",
      moveId: "move-a"
    });
    const a2 = await cat.queryByPath(ACC, MID, "files/Desktop/a.txt");
    check(
      "hash-gate: a verified hash flips available + binds moveId + stamps use",
      r2 === true &&
        a2.availability === "available" &&
        a2.moveId === "move-a" &&
        a2.hash === "verified-a" &&
        typeof a2.lastUsedAt === "string",
      JSON.stringify({ r2, a2 })
    );
    // Known hash + mismatching verified hash -> held back, NOT available.
    const r3 = await cat.applySeedResult(ACC, MID, "files/Desktop/b.txt", {
      verifiedHash: "wrong-b",
      moveId: "move-b"
    });
    const b1 = await cat.queryByPath(ACC, MID, "files/Desktop/b.txt");
    check(
      "hash-gate: a hash mismatch is held back (seeding, named gap)",
      r3 === false &&
        b1.availability === "seeding" &&
        b1.moveId === undefined &&
        typeof b1.gap === "string",
      JSON.stringify({ r3, b1 })
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- GUARD 4: expiry-to-waiting with the ledger still winning -----
  {
    const dir = freshDir();
    const cat = newCatalog(dir);
    await cat.confirmAvailableFromRefs(ACC, MID, [
      { packPath: "files/Desktop/keep.txt", size: 5, modTime: 1, moveId: "mv1" },
      { packPath: "files/Desktop/gone.txt", size: 6, modTime: 1, moveId: "mv1" },
      { packPath: "files/Documents/notes.txt", size: 9, modTime: 1, moveId: "mv1" }
    ]);
    // A copy-side delete + a rename live in the Partition mutate ledger.
    const ledger = [
      {
        id: "pm-1",
        accountId: ACC,
        machineId: MID,
        op: "delete",
        path: "files/Desktop/gone.txt",
        at: "2026-10-28T00:00:00Z",
        confirmed: true
      },
      {
        id: "pm-2",
        accountId: ACC,
        machineId: MID,
        op: "rename",
        path: "files/Documents/notes.txt",
        newName: "notes-renamed.txt",
        at: "2026-10-28T00:00:01Z",
        confirmed: true
      }
    ];
    // Expire a bulk piece: entry survives, returns to waiting, moveId detaches.
    const exp = await cat.expire(ACC, MID, "files/Desktop/keep.txt");
    const keep = await cat.queryByPath(ACC, MID, "files/Desktop/keep.txt");
    check(
      "expiry: bulk expiry -> entry stays, waiting, moveId detached",
      exp === true &&
        keep &&
        keep.availability === "waiting" &&
        keep.moveId === undefined,
      JSON.stringify(keep)
    );
    const live = await cat.browse(ACC, MID, "files/Desktop", ledger);
    check(
      "ledger wins: a ledger-deleted path never appears (even in catalog)",
      !live.children.some((c) => c.name === "gone.txt") &&
        live.children.some((c) => c.name === "keep.txt"),
      JSON.stringify(live.children)
    );
    const docs = await cat.browse(ACC, MID, "files/Documents", ledger);
    check(
      "ledger wins: a ledger rename applies as a view rule over the catalog",
      docs.children.some((c) => c.name === "notes-renamed.txt") &&
        !docs.children.some((c) => c.name === "notes.txt"),
      JSON.stringify(docs.children)
    );
    // Re-seed the deleted path: the ledger must still hide it.
    await cat.confirmAvailableFromRefs(ACC, MID, [
      { packPath: "files/Desktop/gone.txt", size: 6, modTime: 1, moveId: "mv2" }
    ]);
    const live2 = await cat.browse(ACC, MID, "files/Desktop", ledger);
    check(
      "ledger wins: a re-seed never resurrects a ledger-deleted path",
      !live2.children.some((c) => c.name === "gone.txt"),
      JSON.stringify(live2.children)
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- GUARD 5: seeder shape ----------------------------------------
  {
    const dir = freshDir();
    const cat = newCatalog(dir);
    const seeder = new PartitionSeeder(cat);
    // Shell + non-shell, mixed sizes; one already available.
    await cat.mergeHostCatalog(ACC, MID, [
      { packPath: `${SHELL}/big-shell.lnk`, size: 2000, modTime: 1 },
      { packPath: `${SHELL}/small-shell.lnk`, size: 10, modTime: 1 },
      { packPath: `${TASKBAR}/Chrome.lnk`, size: 4, modTime: 1 },
      { packPath: "files/Documents/huge.bin", size: 5000, modTime: 1 },
      { packPath: "files/Documents/tiny.txt", size: 3, modTime: 1 }
    ]);
    // Mark one non-shell as already available (must be excluded from queue).
    await cat.applySeedResult(ACC, MID, "files/Documents/tiny.txt", {
      verifiedHash: "v",
      moveId: "mv"
    });

    const awake = await seeder.plan(ACC, MID, true, []);
    check(
      "seeder: throttle is 20 paths / ~32 MiB / 1 concurrent",
      awake.throttle.pathsPerBatch === SEEDER_BATCH_MAX_PATHS &&
        awake.throttle.bytesPerBatch === SEEDER_BATCH_MAX_BYTES &&
        awake.throttle.concurrentBatches === 1,
      JSON.stringify(awake.throttle)
    );
    check(
      "seeder: available rows are excluded from the queue",
      !awake.queue.includes("files/Documents/tiny.txt"),
      JSON.stringify(awake.queue)
    );
    // Shell set first (ordered by size among shell), then size-ascending rest.
    check(
      "seeder: shell-first then size-ascending order",
      awake.queue.join("|") ===
        [
          `${TASKBAR}/Chrome.lnk`,
          `${SHELL}/small-shell.lnk`,
          `${SHELL}/big-shell.lnk`,
          "files/Documents/huge.bin"
        ].join("|"),
      JSON.stringify(awake.queue)
    );
    check(
      "seeder: every batch uses the files-fetch door ONLY (no push/desk)",
      SEEDER_FETCH_DOOR === "files-fetch" &&
        awake.batches.every((b) => b.door === "files-fetch") &&
        !JSON.stringify(awake.batches).match(/files-push|desk-/),
      JSON.stringify(awake.batches)
    );
    check(
      "seeder: batches respect the path/byte caps",
      awake.batches.every(
        (b) =>
          b.paths.length <= SEEDER_BATCH_MAX_PATHS &&
          (b.bytes <= SEEDER_BATCH_MAX_BYTES || b.paths.length === 1)
      ),
      JSON.stringify(awake.batches.map((b) => [b.paths.length, b.bytes]))
    );

    // Host-awake gate: asleep -> waiting, nothing seeds.
    const asleep = await seeder.plan(ACC, MID, false, []);
    check(
      "seeder: Host-awake gate -> asleep yields waiting, empty queue",
      asleep.state === "waiting" &&
        asleep.queue.length === 0 &&
        asleep.batches.length === 0,
      JSON.stringify(asleep)
    );

    // On-demand preempt: bump a path to the front (awake -> seeding).
    const bump = await seeder.bump(
      ACC,
      MID,
      "files/Documents/huge.bin",
      true,
      []
    );
    const afterBump = await seeder.plan(ACC, MID, true, []);
    check(
      "seeder: on-demand bump -> seeding and jumps to the front of the queue",
      bump.state === "seeding" &&
        afterBump.queue[0] === "files/Documents/huge.bin" &&
        afterBump.onDemand.includes("files/Documents/huge.bin"),
      JSON.stringify({ bump, q: afterBump.queue })
    );
    // On-demand while asleep -> waiting (no pretending content exists).
    const bumpAsleep = await seeder.bump(
      ACC,
      MID,
      `${SHELL}/big-shell.lnk`,
      false,
      []
    );
    check(
      "seeder: on-demand while asleep -> waiting",
      bumpAsleep.state === "waiting",
      JSON.stringify(bumpAsleep)
    );
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nPARTITION CATALOG-FIRST GUARDS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
