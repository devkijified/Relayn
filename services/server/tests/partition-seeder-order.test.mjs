// =========================================================================
// Relayn Partition seeder ORDER GUARD TESTS (owner order 2026-11-05).
// Run:  node node_modules/tsx/dist/cli.mjs tests/partition-seeder-order.test.mjs
//
// The owner restated the pull law: the browser is pulled FIRST
// ("will browser be pulled first to us as priority, that is even
// the first to be pushed") and Access Computer reopens from the
// screen it had before, never starting over like new unless the
// machine is genuinely new. The server half of that law lives in
// the seeder plan's order over the standing catalog:
//
//   a. browser first   -- with browser payload outstanding, a
//      fresh plan queues the browser batches ahead of the shell
//      batches and ahead of everything else. Both shapes of
//      browser payload count: the Chrome profile tree under
//      appData/Local/Google/Chrome/User Data, and any entry the
//      inventory classed browserPrep.
//   b. resume missing  -- a plan built over a standing catalog
//      (persisted, then reloaded by a fresh store) queues ONLY
//      the pieces still missing; what has landed never queues
//      again.
//   c. browser gap     -- a browser piece whose seeding failed
//      (named gap on its catalog entry) stays at the FRONT of
//      the queue with its gap intact: first in line for the
//      next pass, named, never dropped.
// =========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LocalObjectStorage, StateDocs } from "../src/storage.ts";
import {
  PartitionCatalog,
  PARTITION_BROWSER_ROOT
} from "../src/partition-catalog.ts";
import { PartitionSeeder } from "../src/partition-seeder.ts";

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

const ACC = "acctorder01";
const MID = "owner-pc";
const UD = PARTITION_BROWSER_ROOT;

function freshDir() {
  return mkdtempSync(path.join(tmpdir(), "relayn-order-"));
}
function newCatalog(dir) {
  return new PartitionCatalog(new StateDocs(new LocalObjectStorage(dir)));
}

async function main() {
  // ---- PIN a: browser batches before shell batches ------------------
  {
    const dir = freshDir();
    const cat = newCatalog(dir);
    const seeder = new PartitionSeeder(cat);
    await cat.mergeHostCatalog(ACC, MID, [
      // Shell set.
      { packPath: "files/Desktop/a.lnk", size: 5, modTime: 1 },
      { packPath: "setup/wallpaper/w.jpg", size: 9, modTime: 1 },
      // Browser payload, Chrome profile tree shape (appData category).
      { packPath: `${UD}/Default/History`, size: 3000, modTime: 1 },
      { packPath: `${UD}/Default/Cookies`, size: 100, modTime: 1 },
      { packPath: `${UD}/Local State`, size: 700, modTime: 1 },
      // Browser payload, browserPrep category shape.
      {
        packPath: "browserPrep/Default/Bookmarks",
        size: 50,
        modTime: 1,
        category: "browserPrep"
      },
      // The rest.
      { packPath: "files/Documents/big.bin", size: 4000, modTime: 1 }
    ]);
    const plan = await seeder.plan(ACC, MID, true, []);
    const browserPaths = [
      "browserPrep/Default/Bookmarks",
      `${UD}/Default/Cookies`,
      `${UD}/Local State`,
      `${UD}/Default/History`
    ];
    check(
      "browser-first: queue leads with the browser payload, size-ascending",
      plan.queue.slice(0, browserPaths.length).join("|") ===
        browserPaths.join("|"),
      JSON.stringify(plan.queue)
    );
    check(
      "browser-first: shell set follows the browser payload",
      plan.queue.slice(browserPaths.length).join("|") ===
        ["files/Desktop/a.lnk", "setup/wallpaper/w.jpg", "files/Documents/big.bin"].join("|"),
      JSON.stringify(plan.queue)
    );
    const flatBatches = plan.batches.flatMap((b) => b.paths);
    check(
      "browser-first: batches carry the browser payload before any shell path",
      flatBatches.slice(0, browserPaths.length).join("|") ===
        browserPaths.join("|") &&
        plan.batches.every((b) => b.door === "files-fetch"),
      JSON.stringify(plan.batches)
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- PIN b: a plan over a standing catalog queues only missing ----
  {
    const dir = freshDir();
    const cat1 = newCatalog(dir);
    await cat1.mergeHostCatalog(ACC, MID, [
      { packPath: `${UD}/Default/History`, size: 3000, modTime: 1 },
      { packPath: `${UD}/Default/Cookies`, size: 100, modTime: 1 },
      { packPath: "files/Desktop/a.lnk", size: 5, modTime: 1 },
      { packPath: "files/Documents/big.bin", size: 4000, modTime: 1 }
    ]);
    // Two pieces land (one browser, one shell): they stand in the
    // persisted catalog as available.
    await cat1.confirmAvailableFromRefs(ACC, MID, [
      {
        packPath: `${UD}/Default/Cookies`,
        size: 100,
        modTime: 1,
        moveId: "move-1",
        sha256: "h-cookies"
      },
      {
        packPath: "files/Desktop/a.lnk",
        size: 5,
        modTime: 1,
        moveId: "move-1",
        sha256: "h-lnk"
      }
    ]);
    // A fresh store over the same persisted catalog: the standing
    // index, as a reopened Access Computer (or a restarted
    // server) finds it.
    const cat2 = newCatalog(dir);
    const seeder = new PartitionSeeder(cat2);
    const plan = await seeder.plan(ACC, MID, true, []);
    check(
      "resume: landed pieces never queue again",
      !plan.queue.includes(`${UD}/Default/Cookies`) &&
        !plan.queue.includes("files/Desktop/a.lnk"),
      JSON.stringify(plan.queue)
    );
    check(
      "resume: the queue is exactly what is missing, browser first",
      plan.queue.join("|") ===
        [`${UD}/Default/History`, "files/Documents/big.bin"].join("|"),
      JSON.stringify(plan.queue)
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- PIN c: a failed browser piece stays front, gap named ---------
  {
    const dir = freshDir();
    const cat = newCatalog(dir);
    const seeder = new PartitionSeeder(cat);
    const failedPath = `${UD}/Default/History`;
    await cat.mergeHostCatalog(ACC, MID, [
      { packPath: failedPath, size: 3000, modTime: 1, hash: "known-hash" },
      { packPath: `${UD}/Default/Cookies`, size: 100, modTime: 1 },
      { packPath: "files/Desktop/a.lnk", size: 5, modTime: 1 }
    ]);
    // Its seeding run produced bytes that did not match: the
    // catalog names the gap and the piece stays unlanded.
    const flipped = await cat.applySeedResult(ACC, MID, failedPath, {
      verifiedHash: "some-other-hash",
      moveId: "move-x"
    });
    check(
      "browser-gap: a mismatched seed does not flip the piece available",
      flipped === false
    );
    const plan = await seeder.plan(ACC, MID, true, []);
    check(
      "browser-gap: the failed browser piece is still first in the queue",
      plan.queue[0] === failedPath,
      JSON.stringify(plan.queue)
    );
    const entries = await cat.liveEntries(ACC, MID, []);
    const entry = entries.find((e) => e.packPath === failedPath);
    check(
      "browser-gap: the gap stays named on the entry (recallable)",
      !!entry && typeof entry.gap === "string" && entry.gap.length > 0,
      JSON.stringify(entry)
    );
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
