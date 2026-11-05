// =========================================================================
// Relayn Partition index persistence GUARD TESTS.
// Run:  node node_modules/tsx/dist/cli.mjs tests/partition-index-persistence.test.mjs
//
// The Partition index is a derived view over the sealed moves. It
// used to live only in memory, so every server restart forced the
// next open to re-read every sealed manifest. These guards pin
// the durable behavior:
//   1. a fresh PartitionStore over the same docs store serves
//      status/browse from the persisted index with ZERO manifest
//      reads (counted on moverStore.getManifest)
//   2. a rebuild refreshes the persisted index, so the next fresh
//      instance serves the new view, again with zero manifest
//      reads
// =========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LocalObjectStorage, StateDocs } from "../src/storage.ts";
import { PartitionStore } from "../src/partition-store.ts";

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

const ACC = "acctpersist01";
const MID = "owner-pc";

function makeWorld(dir) {
  const docs = new StateDocs(new LocalObjectStorage(dir));
  const world = {
    metas: [{ moveId: "move-1", moverName: "" }],
    manifests: new Map([
      [
        "move-1",
        {
          sourceName: MID,
          files: [
            { path: "files/Desktop/a.txt", size: 10, modTime: 1000 },
            { path: "files/Desktop/b.txt", size: 20, modTime: 1001 },
            { path: "files/Documents/c.txt", size: 30, modTime: 1002 }
          ]
        }
      ]
    ]),
    manifestReads: 0
  };
  const moverStore = {
    docs,
    listMoves: async () => world.metas,
    getManifest: async (_account, moveId) => {
      world.manifestReads++;
      return world.manifests.get(moveId);
    }
  };
  return { docs, world, moverStore };
}

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "relayn-partidx-"));
  try {
    const { docs, world, moverStore } = makeWorld(dir);

    // ---- GUARD 1: restart serves the persisted index ------------
    {
      const store1 = new PartitionStore(moverStore);
      const view = await store1.rebuildFromSealedMoves(ACC, MID);
      check(
        "rebuild: view holds the sealed files",
        view.fileCount === 3,
        JSON.stringify(view)
      );
      check(
        "rebuild: read the manifest while building",
        world.manifestReads === 1,
        String(world.manifestReads)
      );
      const raw = await docs.loadText(`${ACC}/_partition/${MID}/index.json`);
      check(
        "rebuild: persisted an index beside the ledger",
        typeof raw === "string" && raw.includes("files/Desktop/a.txt"),
        String(raw).slice(0, 120)
      );

      // A fresh instance over the same docs store = a restart.
      const store2 = new PartitionStore(moverStore);
      world.manifestReads = 0;
      const st = await store2.status(ACC, MID);
      check(
        "restart: status serves the persisted view",
        st.fileCount === 3 && st.moveIds.join() === "move-1",
        JSON.stringify(st)
      );
      const br = await store2.browse(ACC, MID, "files/Desktop");
      const names = br.children
        .filter((c) => c.kind === "file")
        .map((c) => c.name)
        .join(",");
      check(
        "restart: browse serves the persisted view",
        names === "a.txt,b.txt",
        JSON.stringify(br.children)
      );
      check(
        "restart: ZERO manifest reads on the serve path",
        world.manifestReads === 0,
        String(world.manifestReads)
      );
    }

    // ---- GUARD 2: rebuild refreshes the persisted index ---------
    {
      world.manifests.get("move-1").files.push({
        path: "files/Documents/d.txt",
        size: 40,
        modTime: 1003
      });
      const store2 = new PartitionStore(moverStore);
      world.manifestReads = 0;
      const view = await store2.rebuildFromSealedMoves(ACC, MID);
      check(
        "refresh: rebuild sees the new sealed file",
        view.fileCount === 4 && world.manifestReads === 1,
        JSON.stringify(view) + " reads=" + world.manifestReads
      );

      const store3 = new PartitionStore(moverStore);
      world.manifestReads = 0;
      const st = await store3.status(ACC, MID);
      check(
        "refresh: the next restart serves the refreshed view",
        st.fileCount === 4,
        JSON.stringify(st)
      );
      check(
        "refresh: still ZERO manifest reads after the refresh",
        world.manifestReads === 0,
        String(world.manifestReads)
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(
    `\nPARTITION INDEX PERSISTENCE GUARDS: ${passed} passed, ${failed} failed`
  );
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
