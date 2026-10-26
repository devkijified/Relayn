// =========================================================================
// Relayn server — local endpoint tests (no framework, plain fetch).
// Boots real server instances via tsx and proves:
//   * anonymous share flow still works (upload, single-use download)
//   * account share flow still works (list, one-tap fetch, multi-use)
//   * mover cloud API: presence, announce -> list -> manifest ->
//     chunk up/down round trip, status, chunk cap 413
//   * mover account isolation: a second account sees zero moves, 404s
//   * mover console: 404 without/with wrong key, 404 when the key env
//     is unset, pair creation, both role configs share the account ID,
//     ready build is ONE exe with the config inbuilt (base exe bytes a
//     strict prefix, overlay tail parses back to the exact config),
//     the merged artifact boots paired in an empty dir (config=inbuilt,
//     no account warning), 501 when MOVER_BASE_EXE is unset
// Run:  node tests/relayn-server.test.mjs
// =========================================================================

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(serverDir, "node_modules", "tsx", "dist", "cli.mjs");
const BASE_EXE = path.join(
  process.env.HOME,
  "workspace/relayn-mover/tests/bin/mover"
);
const CONSOLE_KEY = "test-console-key";

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

async function waitHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function boot(port, extraEnv) {
  const child = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CORS_ORIGIN: "",
      ...extraEnv
    },
  "stdio": ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (d) => process.stderr.write(`[srv ${port}] ${d}`));
  return child;
}

// Parse the Mover inbuilt-config overlay off the tail of a merged
// exe: [ exe bytes ][ config JSON ][ uint32 LE length ][ "RLNMCFG1" ].
const OVERLAY_MAGIC = Buffer.from("RLNMCFG1", "ascii");
function parseOverlay(buf) {
  const idx = buf.lastIndexOf(OVERLAY_MAGIC);
  if (idx < 4) return null;
  const n = buf.readUInt32LE(idx - 4);
  if (n <= 0 || idx - 4 - n < 0) return null;
  const jsonBuf = buf.subarray(idx - 4 - n, idx - 4);
  let cfg = null;
  try {
    cfg = JSON.parse(jsonBuf.toString("utf8"));
  } catch {
    return null;
  }
  return { cfg, jsonLen: n, magicAtEnd: idx === buf.length - OVERLAY_MAGIC.length };
}

// Key-order-insensitive JSON comparison.
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon(v[k])])
        )
      : v;
const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// Boot a merged artifact alone in a fresh empty dir and report what
// its own log and /api/state say.
async function bootMerged(buf, filename) {
  const dir = mkdtempSync(path.join(tmpdir(), "relayn-merged-boot-"));
  const exePath = path.join(dir, filename);
  writeFileSync(exePath, buf);
  chmodSync(exePath, 0o755);
  let out = "";
  const child = spawn(exePath, [], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  let state = null;
  for (let i = 0; i < 100 && !state; i++) {
    try {
      const res = await fetch("http://127.0.0.1:8770/api/state");
      if (res.ok) state = await res.json();
    } catch {
      // not up yet
    }
    if (!state) await new Promise((r) => setTimeout(r, 300));
  }
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 600));
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
  return { state, out };
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "relayn-mover-test-"));
  const children = [];
  try {
    // ---------------------------------------------------------------
    // Instance A: everything on (console key + base exe set).
    // ---------------------------------------------------------------
    const A = 4417;
    children.push(
      boot(A, {
        MOVER_DATA_DIR: dataDir,
        MOVER_MAX_CHUNK_MB: "1",
        MOVER_CONSOLE_KEY: CONSOLE_KEY,
        MOVER_BASE_EXE: BASE_EXE
      })
    );
    check("instance A boots", await waitHealth(A));
    const a = `http://127.0.0.1:${A}`;

    // ---- anonymous share regression ------------------------------
    console.log("anonymous share flow");
    const blob = {
      iv: randomBytes(12).toString("base64"),
      data: randomBytes(256).toString("base64")
    };
    let r = await fetch(`${a}/api/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob, cookieCount: 10, siteCount: 3 })
    });
    check("anon share create 201", r.status === 201, `got ${r.status}`);
    const anonId = (await r.json()).id;
    r = await fetch(`${a}/api/share/${anonId}`);
    const anonGot = await r.json();
    check(
      "anon share download 200 + blob round trip",
      r.status === 200 && anonGot.blob?.data === blob.data
    );
    r = await fetch(`${a}/api/share/${anonId}`);
    check("anon share is single-use (2nd GET 404)", r.status === 404);

    // ---- account share regression --------------------------------
    console.log("account share flow");
    const acct = "acctshare123";
    const key = randomBytes(32).toString("base64");
    r = await fetch(`${a}/api/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blob,
        cookieCount: 5,
        siteCount: 2,
        accountId: acct,
        key
      })
    });
    check("account share create 201", r.status === 201, `got ${r.status}`);
    const acctShareId = (await r.json()).id;
    r = await fetch(`${a}/api/account/${acct}/shares`);
    const list = await r.json();
    check(
      "account inbox lists the share",
      r.status === 200 && list.shares?.some((s) => s.id === acctShareId)
    );
    r = await fetch(`${a}/api/account/${acct}/shares/${acctShareId}`);
    const full = await r.json();
    check(
      "account share fetch returns blob + key",
      r.status === 200 && full.key === key && full.blob?.data === blob.data
    );
    r = await fetch(`${a}/api/account/${acct}/shares/${acctShareId}`);
    check("account share is multi-use (2nd GET 200)", r.status === 200);

    // ---- mover cloud API -----------------------------------------
    console.log("mover cloud API");
    const ACC = "mvtestacct0001";
    const H = { "x-account-id": ACC, "content-type": "application/json" };

    r = await fetch(`${a}/api/moves`);
    check("no account header -> 401", r.status === 401, `got ${r.status}`);
    r = await fetch(`${a}/api/moves`, { headers: { "x-account-id": "bad!" } });
    check("invalid account header -> 401", r.status === 401);

    const machine = {
      role: "mover",
      name: "OLD-LAPTOP",
      address: "http://100.64.0.2:8771"
    };
    r = await fetch(`${a}/api/machines`, {
      method: "POST",
      headers: H,
      body: JSON.stringify(machine)
    });
    check("presence register ok", r.status === 200 && (await r.json()).ok === "true");
    await fetch(`${a}/api/machines`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ role: "admin", name: "NEW-LAPTOP", address: "" })
    });
    // heartbeat: same role+name again must replace, not duplicate
    await fetch(`${a}/api/machines`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ ...machine, address: "http://100.64.0.9:8771" })
    });
    r = await fetch(`${a}/api/machines`, { headers: H });
    const machines = await r.json();
    check(
      "presence list = 2, heartbeat replaced address",
      Array.isArray(machines) &&
        machines.length === 2 &&
        machines.find((m) => m.role === "mover")?.address ===
          "http://100.64.0.9:8771",
      JSON.stringify(machines)
    );

    const manifest = {
      moveId: "move-1234567890-4242",
      name: "Test move",
      sourceName: "OLD-LAPTOP",
      createdAt: "2026-10-26T13:00:00Z",
      categories: { files: 11 },
      files: [
        { path: "files/a.txt", category: "files", size: 5, sha256: "x", chunks: 1 },
        { path: "files/b.bin", category: "files", size: 6, sha256: "y", chunks: 2 }
      ],
      chunks: [
        { index: 0, path: "files/a.txt", offset: 0, size: 5, sha256: "x" },
        { index: 1, path: "files/b.bin", offset: 0, size: 3, sha256: "y" },
        { index: 2, path: "files/b.bin", offset: 3, size: 3, sha256: "z" }
      ],
      totalBytes: 11,
      totalFiles: 2
    };
    r = await fetch(`${a}/api/moves`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ moverName: "OLD-LAPTOP", manifest })
    });
    const meta = await r.json();
    check(
      "announce 200 with meta (announced, chunks=3)",
      r.status === 200 &&
        meta.status === "announced" &&
        meta.chunks === 3 &&
        meta.totalBytes === 11 &&
        meta.account === ACC,
      JSON.stringify(meta)
    );

    r = await fetch(`${a}/api/moves`, { headers: H });
    const moves = await r.json();
    check(
      "inbox lists the announced move",
      Array.isArray(moves) && moves.length === 1 && moves[0].moveId === manifest.moveId
    );

    r = await fetch(`${a}/api/moves/${manifest.moveId}/manifest`, {
      headers: H
    });
    const gotManifest = await r.json();
    check(
      "manifest round trip",
      r.status === 200 &&
        gotManifest.moveId === manifest.moveId &&
        gotManifest.files?.length === 2 &&
        gotManifest.chunks?.length === 3
    );

    const chunk0 = randomBytes(64 * 1024);
    const chunk2 = randomBytes(1024);
    const putChunk = (n, data) =>
      fetch(`${a}/api/moves/${manifest.moveId}/chunks/${n}`, {
        method: "PUT",
        headers: { "x-account-id": ACC, "content-type": "application/octet-stream" },
        body: data
      });
    r = await putChunk(0, chunk0);
    check("chunk 0 PUT ok", r.status === 200 && (await r.json()).ok === "true");
    r = await putChunk(2, chunk2);
    check("chunk 2 PUT ok", r.status === 200);
    r = await fetch(`${a}/api/moves/${manifest.moveId}/chunks`, { headers: H });
    const present = await r.json();
    check(
      "present chunks = [0, 2]",
      JSON.stringify(present.present) === "[0,2]",
      JSON.stringify(present)
    );
    r = await fetch(`${a}/api/moves/${manifest.moveId}/chunks/0`, {
      headers: { "x-account-id": ACC }
    });
    const down = Buffer.from(await r.arrayBuffer());
    check(
      "chunk 0 download byte-identical",
      r.status === 200 && down.equals(chunk0)
    );
    r = await fetch(`${a}/api/moves/${manifest.moveId}/chunks/1`, {
      headers: { "x-account-id": ACC }
    });
    check("missing chunk -> 404", r.status === 404);

    r = await putChunk(3, randomBytes(1536 * 1024)); // cap is 1 MB here
    const capBody = await r.json().catch(() => ({}));
    check(
      "oversize chunk -> 413 Go shape",
      r.status === 413 && capBody.error === "chunk exceeds cloud.maxChunkMB",
      `got ${r.status} ${JSON.stringify(capBody)}`
    );

    r = await fetch(`${a}/api/moves/${manifest.moveId}/status`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ status: "sent" })
    });
    const meta2 = await r.json();
    check("status update -> sent", r.status === 200 && meta2.status === "sent");
    r = await fetch(`${a}/api/moves`, { headers: H });
    check(
      "inbox shows updated status",
      (await r.json())[0]?.status === "sent"
    );

    // ---- mover isolation ------------------------------------------
    console.log("mover account isolation");
    const HB = {
      "x-account-id": "otheracct999",
      "content-type": "application/json"
    };
    r = await fetch(`${a}/api/moves`, { headers: HB });
    check("other account inbox is empty", r.status === 200 && (await r.json()).length === 0);
    r = await fetch(`${a}/api/moves/${manifest.moveId}/manifest`, { headers: HB });
    check("other account manifest -> 404", r.status === 404);
    r = await fetch(`${a}/api/moves/${manifest.moveId}/chunks`, { headers: HB });
    check("other account chunk list -> 404", r.status === 404);
    r = await fetch(`${a}/api/moves/${manifest.moveId}/chunks/0`, { headers: HB });
    check("other account chunk download -> 404", r.status === 404);
    r = await fetch(`${a}/api/machines`, { headers: HB });
    check("other account presence is empty", r.status === 200 && (await r.json()).length === 0);

    // ---- mover console --------------------------------------------
    console.log("mover console");
    r = await fetch(`${a}/mover/console`);
    check("console page without key -> 404", r.status === 404);
    r = await fetch(`${a}/mover/console?key=wrong-key`);
    check("console page with wrong key -> 404", r.status === 404);
    r = await fetch(`${a}/mover/console?key=${CONSOLE_KEY}`);
    const html = await r.text();
    check(
      "console page with key -> 200 HTML",
      r.status === 200 && html.includes("Relayn Mover Console")
    );
    r = await fetch(`${a}/mover/console/api/pairs`, { method: "POST" });
    check("console pair create without key -> 404", r.status === 404);

    const KH = { "x-console-key": CONSOLE_KEY, "content-type": "application/json" };
    r = await fetch(`${a}/mover/console/api/pairs`, {
      method: "POST",
      headers: KH,
      body: "{}"
    });
    const pair = await r.json();
    check(
      "pair created with mv-prefixed account id",
      r.status === 200 && /^mv[0-9a-f]{20}$/.test(pair.accountId ?? ""),
      JSON.stringify(pair)
    );

    const getConfig = async (role) => {
      const res = await fetch(`${a}/mover/console/api/config`, {
        method: "POST",
        headers: KH,
        body: JSON.stringify({ accountId: pair.accountId, role })
      });
      return { status: res.status, cfg: await res.json() };
    };
    const moverCfg = await getConfig("mover");
    const adminCfg = await getConfig("admin");
    check(
      "mover config: role + features + account",
      moverCfg.status === 200 &&
        moverCfg.cfg.role === "mover" &&
        moverCfg.cfg.account.id === pair.accountId &&
        moverCfg.cfg.features.move === true &&
        moverCfg.cfg.features.inbox === false &&
        moverCfg.cfg.features.import === false,
      JSON.stringify(moverCfg.cfg).slice(0, 200)
    );
    check(
      "admin config: same account, flipped features",
      adminCfg.status === 200 &&
        adminCfg.cfg.role === "admin" &&
        adminCfg.cfg.account.id === pair.accountId &&
        adminCfg.cfg.features.move === false &&
        adminCfg.cfg.features.inbox === true &&
        adminCfg.cfg.features.import === true
    );
    check(
      "configs carry schema defaults (warn-only, fresh-import, messages)",
      moverCfg.cfg.space?.policy === "warn-only" &&
        moverCfg.cfg.mode === "fresh-import" &&
        moverCfg.cfg.server?.url === "https://relayn-server.onrender.com" &&
        typeof moverCfg.cfg.messages?.appTitle === "string" &&
        moverCfg.cfg.transfer?.laneOrder?.[0] === "internet"
    );

    // Ready build: ONE exe with the config inbuilt as an overlay.
    r = await fetch(`${a}/mover/console/api/package`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: pair.accountId, role: "admin" })
    });
    check("ready build (admin) download 200", r.status === 200, `got ${r.status}`);
    check(
      "admin build filename is relayn-mover-admin.exe",
      (r.headers.get("content-disposition") ?? "").includes(
        'filename="relayn-mover-admin.exe"'
      ),
      r.headers.get("content-disposition") ?? ""
    );
    const mergedAdmin = Buffer.from(await r.arrayBuffer());
    const sourceExe = readFileSync(BASE_EXE);
    check(
      "merged exe keeps base exe bytes as strict prefix (never transformed)",
      mergedAdmin.length > sourceExe.length &&
        mergedAdmin.subarray(0, sourceExe.length).equals(sourceExe) &&
        sha256(mergedAdmin.subarray(0, sourceExe.length)) === sha256(sourceExe)
    );
    const tailAdmin = parseOverlay(mergedAdmin);
    check(
      "overlay tail ends the file (magic last, length matches)",
      !!tailAdmin &&
        tailAdmin.magicAtEnd &&
        mergedAdmin.length === sourceExe.length + tailAdmin.jsonLen + 12
    );
    check(
      "overlay tail parses back to the exact generated admin config",
      !!tailAdmin &&
        tailAdmin.cfg.account?.id === pair.accountId &&
        tailAdmin.cfg.role === "admin" &&
        tailAdmin.cfg.features?.move === false &&
        tailAdmin.cfg.features?.inbox === true &&
        tailAdmin.cfg.features?.import === true &&
        sameJson(tailAdmin.cfg, adminCfg.cfg),
      tailAdmin ? JSON.stringify(tailAdmin.cfg).slice(0, 200) : "no overlay"
    );

    r = await fetch(`${a}/mover/console/api/package`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: pair.accountId, role: "mover" })
    });
    check(
      "mover build filename is relayn-mover.exe",
      r.status === 200 &&
        (r.headers.get("content-disposition") ?? "").includes(
          'filename="relayn-mover.exe"'
        ),
      r.headers.get("content-disposition") ?? ""
    );
    const tailMover = parseOverlay(Buffer.from(await r.arrayBuffer()));
    check(
      "mover overlay carries the mover side of the same pair",
      !!tailMover &&
        tailMover.cfg.account?.id === pair.accountId &&
        tailMover.cfg.role === "mover" &&
        tailMover.cfg.features?.move === true &&
        tailMover.cfg.features?.import === false &&
        sameJson(tailMover.cfg, moverCfg.cfg)
    );

    // Real proof: the merged admin artifact, alone in an empty dir,
    // boots paired on the inbuilt config — no sidecar, no warning.
    const bootProof = await bootMerged(mergedAdmin, "relayn-mover-admin");
    check(
      "merged artifact boots and answers /api/state",
      !!bootProof.state,
      bootProof.out.slice(0, 300)
    );
    check(
      "merged artifact starts paired: role admin, features, accountLinked",
      bootProof.state?.role === "admin" &&
        bootProof.state?.features?.move === false &&
        bootProof.state?.features?.inbox === true &&
        bootProof.state?.features?.import === true &&
        bootProof.state?.accountLinked === true,
      JSON.stringify(bootProof.state).slice(0, 200)
    );
    check(
      "merged artifact booted on the inbuilt overlay, no account warning",
      bootProof.out.includes("config=inbuilt") &&
        bootProof.out.includes("role=admin") &&
        !bootProof.out.includes("account.id missing or invalid"),
      bootProof.out.slice(0, 300)
    );

    // ---------------------------------------------------------------
    // Instance B: no console key in env -> console does not exist.
    // ---------------------------------------------------------------
    const B = 4418;
    children.push(boot(B, { MOVER_DATA_DIR: `${dataDir}-b` }));
    check("instance B boots", await waitHealth(B));
    r = await fetch(`http://127.0.0.1:${B}/mover/console?key=${CONSOLE_KEY}`);
    check("console 404 when MOVER_CONSOLE_KEY unset (page)", r.status === 404);
    r = await fetch(`http://127.0.0.1:${B}/mover/console/api/pairs`, {
      method: "POST",
      headers: KH
    });
    check("console 404 when MOVER_CONSOLE_KEY unset (api)", r.status === 404);

    // ---------------------------------------------------------------
    // Instance C: console key set, base exe unset -> package 501.
    // ---------------------------------------------------------------
    const C = 4419;
    children.push(
      boot(C, {
        MOVER_DATA_DIR: `${dataDir}-c`,
        MOVER_CONSOLE_KEY: CONSOLE_KEY
      })
    );
    check("instance C boots", await waitHealth(C));
    r = await fetch(`http://127.0.0.1:${C}/mover/console/api/package`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: pair.accountId, role: "mover" })
    });
    const body501 = await r.json().catch(() => ({}));
    check(
      "package without MOVER_BASE_EXE -> 501 clear error",
      r.status === 501 && body501.error === "BASE_EXE_NOT_CONFIGURED",
      `got ${r.status} ${JSON.stringify(body501)}`
    );
    r = await fetch(`http://127.0.0.1:${C}/mover/console/api/config`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: pair.accountId, role: "mover" })
    });
    check("config download still works without base exe", r.status === 200);
  } finally {
    for (const child of children) child.kill("SIGTERM");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
