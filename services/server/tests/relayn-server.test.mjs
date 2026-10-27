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
//   * licenses + unified console: seeded licenses, issue/list, the
//     tabbed page shell, host + viewer configs and build names,
//     overview + cross-account moves, revoke blocking enroll and
//     downloads with 403 LICENSE_REVOKED, restore reopening both
//   * headless track: enroll + machine secret auth (failures included),
//     heartbeat, console machine list (account-scoped, no secret),
//     scan/browse/paths command queueing and clearing, result storage,
//     signed start commands (HMAC recomputed in the test),
//   * files door: files-browse queueing, the signed files-fetch and
//     files-push commands (HMAC recomputed in the test), the
//     server-side confirm rule for fetches, the transfer ledger a
//     files result folds into, and license gating on fetch/push,
//     ready build is ONE exe with the config inbuilt (base exe bytes a
//     strict prefix, overlay tail parses back to the exact config),
//     the merged artifact boots paired in an empty dir (config=inbuilt,
//     no account warning), 501 when MOVER_BASE_EXE is unset
// Run:  node tests/relayn-server.test.mjs
// =========================================================================

import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
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

// Minimal ZIP reader for the EXT package downloads: walks the
// central directory and inflates each entry.
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compLen = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataAt, dataAt + compLen);
    out[name] = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
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
    check(
      "console colour fields are native pickers with synced hex boxes",
      html.includes('type="color"') &&
        html.includes('id="brandColorPick"') &&
        html.includes('id="brandSuccessBgPick"') &&
        html.includes('id="brandSuccessPick"') &&
        html.includes('id="brandColor"') &&
        html.includes('id="brandSuccessBg"') &&
        html.includes('id="brandSuccess"')
    );
    const selectBlock = (id) => {
      const i = html.indexOf(`id="${id}"`);
      return i < 0 ? "" : html.slice(i, html.indexOf("</select>", i));
    };
    check(
      "chunk size is a select with the server cap (64) preselected",
      selectBlock("chunkMB").includes('<option value="8">') &&
        selectBlock("chunkMB").includes('<option value="64" selected>')
    );
    check(
      "parallel streams select tops out preselected at the app max (64)",
      selectBlock("streams").includes('<option value="64" selected>')
    );
    check(
      "io buffer select tops out preselected at the app max (65536)",
      selectBlock("ioBufferKB").includes('<option value="65536" selected>')
    );
    check(
      "bandwidth, retry, backoff, timeout and delay are selects too",
      selectBlock("bandwidthMbps").includes('<option value="0" selected>') &&
        selectBlock("retryCount").includes('<option value="5" selected>') &&
        selectBlock("retryBackoffMs").includes(
          '<option value="250" selected>'
        ) &&
        selectBlock("chunkTimeoutSec").includes(
          '<option value="600" selected>'
        ) &&
        selectBlock("chunkDelayMs").includes('<option value="0" selected>')
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
    check(
      "default transfer values run at max (chunk 64, streams 64, buffer 65536)",
      moverCfg.cfg.transfer?.chunkSizeMB === 64 &&
        moverCfg.cfg.transfer?.parallelStreams === 64 &&
        moverCfg.cfg.transfer?.ioBufferKB === 65536 &&
        moverCfg.cfg.transfer?.bandwidthLimitMbps === 0 &&
        moverCfg.cfg.transfer?.chunkDelayMs === 0,
      JSON.stringify(moverCfg.cfg.transfer)
    );
    check(
      "transfer exceptions stay at their deliberate defaults (retry 5, backoff 250, timeout 600)",
      moverCfg.cfg.transfer?.retryCount === 5 &&
        moverCfg.cfg.transfer?.retryBackoffMs === 250 &&
        moverCfg.cfg.transfer?.chunkTimeoutSec === 600,
      JSON.stringify(moverCfg.cfg.transfer)
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

    // ---- headless machines ----------------------------------------
    console.log("headless machines");
    check(
      "console page carries the headless Machines section with a confirmation step",
      html.includes("Machines (headless)") &&
        html.includes('id="loadMachines"') &&
        html.includes('id="machineList"') &&
        html.includes('id="confirmStart"')
    );
    const HL_ACC = pair.accountId;
    const HL_MID = "retire-laptop-01";
    const summaryFixture = {
      totalBytes: 11,
      totalFiles: 2,
      groups: [
        { key: "files", label: "files", category: "files", count: 2, bytes: 11 }
      ],
      diagnostics: {}
    };

    r = await fetch(`${a}/api/headless/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: HL_MID, name: "RETIRE-ME" })
    });
    check("headless enroll without account -> 401", r.status === 401, `got ${r.status}`);
    r = await fetch(`${a}/api/headless/enroll`, {
      method: "POST",
      headers: { "x-account-id": HL_ACC, "content-type": "application/json" },
      body: JSON.stringify({
        machineId: HL_MID,
        name: "RETIRE-ME",
        os: "Windows 10 Pro",
        profiles: ["USER"],
        capabilities: { desktop: false }
      })
    });
    const enrolled = await r.json();
    check(
      "headless enroll returns a per-machine secret",
      r.status === 200 &&
        /^[0-9a-f]{64}$/.test(enrolled.machineSecret ?? "") &&
        enrolled.machineId === HL_MID,
      JSON.stringify(enrolled)
    );
    const SECRET = enrolled.machineSecret;
    const beat = (headers, body) =>
      fetch(`${a}/api/headless/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body ?? { state: "idle" })
      });
    r = await beat({ "x-account-id": HL_ACC });
    check("heartbeat without machine headers -> 401", r.status === 401);
    r = await beat({
      "x-account-id": HL_ACC,
      "x-machine-id": HL_MID,
      "x-machine-secret": "deadbeef".repeat(8)
    });
    check("heartbeat with wrong secret -> 401", r.status === 401);
    const MAUTH = {
      "x-account-id": HL_ACC,
      "x-machine-id": HL_MID,
      "x-machine-secret": SECRET
    };
    r = await beat(MAUTH, { state: "idle", jobId: "", progress: null });
    check(
      "heartbeat with the enrolled secret -> 200",
      r.status === 200 && (await r.json()).ok === "true"
    );
    r = await beat({ ...MAUTH, "x-account-id": "otheracct999" });
    check("machine secret does not authenticate under another account", r.status === 401);

    r = await fetch(`${a}/api/headless/commands`, { headers: MAUTH });
    check(
      "command poll starts empty",
      r.status === 200 && (await r.json()).commands?.length === 0
    );

    r = await fetch(`${a}/mover/console/api/machines?accountId=${HL_ACC}`);
    check("console machines list without key -> 404", r.status === 404);
    r = await fetch(`${a}/mover/console/api/machines?accountId=${HL_ACC}`, {
      headers: { "x-console-key": CONSOLE_KEY }
    });
    const machineList = await r.json();
    check(
      "console lists the enrolled machine (online, no secret leaked)",
      r.status === 200 &&
        machineList.machines?.length === 1 &&
        machineList.machines[0].machineId === HL_MID &&
        machineList.machines[0].name === "RETIRE-ME" &&
        machineList.machines[0].online === true &&
        machineList.machines[0].capabilities?.desktop === false &&
        !JSON.stringify(machineList).includes(SECRET),
      JSON.stringify(machineList).slice(0, 200)
    );
    r = await fetch(`${a}/mover/console/api/machines?accountId=otheracct999`, {
      headers: { "x-console-key": CONSOLE_KEY }
    });
    check(
      "console machine list is account-scoped",
      r.status === 200 && (await r.json()).machines?.length === 0
    );

    // Run mode: the guard reports how it is hosted (the planted
    // service vs a temporary foreground copy) and the fold +
    // the view carry it, so the viewers can name the mode and
    // its limits instead of guessing why a machine went quiet.
    r = await beat(MAUTH, { state: "idle", runMode: "foreground" });
    const beatOk = r.status === 200;
    r = await fetch(`${a}/mover/console/api/machines?accountId=${HL_ACC}`, {
      headers: { "x-console-key": CONSOLE_KEY }
    });
    const rmList = await r.json();
    check(
      "run mode folds from heartbeat into the machines list",
      beatOk &&
        rmList.machines?.length === 1 &&
        rmList.machines[0].runMode === "foreground",
      JSON.stringify(rmList).slice(0, 200)
    );
    r = await fetch(`${a}/api/headless/enroll`, {
      method: "POST",
      headers: { "x-account-id": "runmodeacc01", "content-type": "application/json" },
      body: JSON.stringify({ machineId: "hl-norunmode", name: "OLD-ENGINE", runMode: "service" })
    });
    const rmEnrolled = r.status === 200 ? await r.json() : {};
    r = await fetch(`${a}/mover/console/api/machines?accountId=runmodeacc01`, {
      headers: { "x-console-key": CONSOLE_KEY }
    });
    const rmList2 = await r.json();
    const rmRow = (rmList2.machines ?? []).find((m) => m.machineId === "hl-norunmode");
    check(
      "run mode folds from enroll into the machines list",
      !!rmEnrolled.machineSecret && !!rmRow && rmRow.runMode === "service",
      JSON.stringify(rmRow ?? {}).slice(0, 200)
    );

    r = await fetch(`${a}/mover/console/api/machines/${HL_MID}/scan`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: HL_ACC })
    });
    const scanQueued = await r.json();
    check(
      "console scan queues a command",
      r.status === 200 && /^cmd-[0-9a-f]{20}$/.test(scanQueued.commandId ?? ""),
      JSON.stringify(scanQueued)
    );
    r = await fetch(`${a}/api/headless/commands`, { headers: MAUTH });
    const polled = await r.json();
    check(
      "machine polls the scan command (unsigned)",
      polled.commands?.length === 1 &&
        polled.commands[0].id === scanQueued.commandId &&
        polled.commands[0].type === "scan" &&
        !("signature" in polled.commands[0])
    );
    r = await fetch(`${a}/api/headless/commands`, { headers: MAUTH });
    check("command poll clears the queue", (await r.json()).commands?.length === 0);
    r = await fetch(`${a}/api/headless/commands/${scanQueued.commandId}/result`, {
      method: "POST",
      headers: { ...MAUTH, "content-type": "application/json" },
      body: JSON.stringify({ result: summaryFixture })
    });
    check("machine posts the scan result", r.status === 200);
    r = await fetch(
      `${a}/mover/console/api/machines/${HL_MID}/result/${scanQueued.commandId}?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    const scanResult = await r.json();
    check(
      "console reads the stored scan result",
      r.status === 200 &&
        scanResult.status === "done" &&
        scanResult.result?.totalFiles === 2 &&
        scanResult.result?.groups?.length === 1,
      JSON.stringify(scanResult).slice(0, 200)
    );
    r = await fetch(`${a}/api/headless/commands/cmd-nope/result`, {
      method: "POST",
      headers: MAUTH,
      body: JSON.stringify({ result: {} })
    });
    check("result for an unknown command -> 404", r.status === 404);

    const queueConsole = async (action, body) => {
      const res = await fetch(`${a}/mover/console/api/machines/${HL_MID}/${action}`, {
        method: "POST",
        headers: KH,
        body: JSON.stringify({ accountId: HL_ACC, ...body })
      });
      return { status: res.status, data: await res.json() };
    };
    const browseQ = await queueConsole("browse", { prefix: "files" });
    const pathsQ = await queueConsole("paths", { prefix: "files" });
    check(
      "console queues browse + paths commands",
      browseQ.status === 200 && pathsQ.status === 200
    );
    r = await fetch(`${a}/api/headless/commands`, { headers: MAUTH });
    const cmds2 = (await r.json()).commands ?? [];
    check(
      "browse + paths arrive with their payloads",
      cmds2.length === 2 &&
        cmds2.find((c) => c.id === browseQ.data.commandId)?.type === "browse" &&
        cmds2.find((c) => c.id === browseQ.data.commandId)?.payload?.prefix === "files" &&
        cmds2.find((c) => c.id === pathsQ.data.commandId)?.type === "paths" &&
        cmds2.find((c) => c.id === pathsQ.data.commandId)?.payload?.prefix === "files",
      JSON.stringify(cmds2).slice(0, 200)
    );

    const startBody = {
      accountId: HL_ACC,
      moveName: "Retire RETIRE-ME",
      paths: ["files/a.txt", "files/b.bin"]
    };
    r = await fetch(`${a}/mover/console/api/machines/${HL_MID}/start`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ ...startBody, paths: [] })
    });
    check(
      "start with an empty path list -> 400 (no verified selection, no start)",
      r.status === 400,
      `got ${r.status}`
    );
    r = await fetch(`${a}/mover/console/api/machines/${HL_MID}/start`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify(startBody)
    });
    const startQueued = await r.json();
    check(
      "console start queues a signed command",
      r.status === 200 && /^[0-9a-f]{64}$/.test(startQueued.signature ?? ""),
      JSON.stringify(startQueued)
    );
    r = await fetch(`${a}/api/headless/commands`, { headers: MAUTH });
    const startCmd = ((await r.json()).commands ?? [])[0];
    const expectedSig = createHmac("sha256", SECRET)
      .update(
        JSON.stringify(
          canon({
            id: startQueued.commandId,
            type: "start",
            payload: { moveName: startBody.moveName, paths: startBody.paths }
          })
        )
      )
      .digest("hex");
    check(
      "start signature verifies against canonical JSON + machine secret",
      !!startCmd &&
        startCmd.id === startQueued.commandId &&
        startCmd.type === "start" &&
        startCmd.signature === expectedSig &&
        startCmd.signature === startQueued.signature,
      JSON.stringify(startCmd)
    );
    r = await fetch(`${a}/mover/console/api/machines/ghost-01/scan`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: HL_ACC })
    });
    check("console command for an unknown machine -> 404", r.status === 404);

    // Re-enroll semantics: "pending" means NEVER DELIVERED only.
    // Queue two commands and deliver both via the poll, queue a
    // third and never deliver it, then re-enroll (fresh secret).
    // The undelivered third must be gone; the two delivered ones are
    // in flight and must still accept results posted with the NEW
    // secret, readable back through the console result endpoint.
    const reScanQ = await queueConsole("scan", {});
    const reBrowseQ = await queueConsole("browse", { prefix: "files" });
    check(
      "re-enroll scenario: two more commands queued",
      reScanQ.status === 200 && reBrowseQ.status === 200
    );
    r = await fetch(`${a}/api/headless/commands`, { headers: MAUTH });
    const rePolled = (await r.json()).commands ?? [];
    check(
      "re-enroll scenario: both commands delivered by poll",
      rePolled.length === 2 &&
        rePolled.some((c) => c.id === reScanQ.data.commandId) &&
        rePolled.some((c) => c.id === reBrowseQ.data.commandId),
      JSON.stringify(rePolled).slice(0, 200)
    );
    const rePendingQ = await queueConsole("paths", { prefix: "files" });
    check(
      "re-enroll scenario: third command queued but never delivered",
      rePendingQ.status === 200
    );
    r = await fetch(`${a}/api/headless/enroll`, {
      method: "POST",
      headers: { "x-account-id": HL_ACC, "content-type": "application/json" },
      body: JSON.stringify({
        machineId: HL_MID,
        name: "RETIRE-ME",
        os: "Windows 10 Pro",
        profiles: ["USER"],
        capabilities: { desktop: false }
      })
    });
    const reEnrolled = await r.json();
    check(
      "re-enroll mints a fresh secret",
      r.status === 200 &&
        /^[0-9a-f]{64}$/.test(reEnrolled.machineSecret ?? "") &&
        reEnrolled.machineSecret !== SECRET,
      JSON.stringify(reEnrolled)
    );
    const SECRET2 = reEnrolled.machineSecret;
    const MAUTH2 = {
      "x-account-id": HL_ACC,
      "x-machine-id": HL_MID,
      "x-machine-secret": SECRET2
    };
    r = await beat(MAUTH, { state: "idle" });
    check("old secret stops working after re-enroll", r.status === 401);
    r = await fetch(`${a}/api/headless/commands`, { headers: MAUTH2 });
    check(
      "after re-enroll the poll is empty (undelivered dropped, delivered not re-sent)",
      r.status === 200 && (await r.json()).commands?.length === 0
    );
    r = await fetch(
      `${a}/api/headless/commands/${rePendingQ.data.commandId}/result`,
      {
        method: "POST",
        headers: { ...MAUTH2, "content-type": "application/json" },
        body: JSON.stringify({ result: { prefix: "files", paths: [] } })
      }
    );
    check(
      "never-delivered command is gone after re-enroll (result -> 404)",
      r.status === 404
    );
    r = await fetch(
      `${a}/mover/console/api/machines/${HL_MID}/result/${rePendingQ.data.commandId}?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    check("console also reads the dropped command as 404", r.status === 404);
    const reScanResult = { ...summaryFixture, totalFiles: 7 };
    r = await fetch(
      `${a}/api/headless/commands/${reScanQ.data.commandId}/result`,
      {
        method: "POST",
        headers: { ...MAUTH2, "content-type": "application/json" },
        body: JSON.stringify({ result: reScanResult })
      }
    );
    check(
      "delivered command still accepts its result after re-enroll (new secret)",
      r.status === 200
    );
    const reBrowseResult = {
      prefix: "files",
      count: 1,
      bytes: 5,
      total: 1,
      offset: 0,
      limit: 200,
      children: [
        { kind: "file", name: "a.txt", path: "files/a.txt", size: 5 }
      ]
    };
    r = await fetch(
      `${a}/api/headless/commands/${reBrowseQ.data.commandId}/result`,
      {
        method: "POST",
        headers: { ...MAUTH2, "content-type": "application/json" },
        body: JSON.stringify({ result: reBrowseResult })
      }
    );
    check(
      "second delivered command also accepts its result after re-enroll",
      r.status === 200
    );
    r = await fetch(
      `${a}/mover/console/api/machines/${HL_MID}/result/${reScanQ.data.commandId}?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    const reScanRead = await r.json();
    check(
      "console reads back the post-re-enroll result (scan)",
      r.status === 200 &&
        reScanRead.status === "done" &&
        reScanRead.result?.totalFiles === 7,
      JSON.stringify(reScanRead).slice(0, 200)
    );
    r = await fetch(
      `${a}/mover/console/api/machines/${HL_MID}/result/${reBrowseQ.data.commandId}?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    const reBrowseRead = await r.json();
    check(
      "console reads back the post-re-enroll result (browse)",
      r.status === 200 &&
        reBrowseRead.status === "done" &&
        reBrowseRead.result?.children?.[0]?.path === "files/a.txt",
      JSON.stringify(reBrowseRead).slice(0, 200)
    );

    // ---- Background Admin (desk) ----------------------------------
    console.log("background admin (desk)");
    check(
      "generated pair configs carry the headless + desk blocks",
      moverCfg.cfg.headless?.enroll === true &&
        moverCfg.cfg.desk?.desktopName === "RelaynDesk" &&
        moverCfg.cfg.desk?.idleTtlSec === 900,
      JSON.stringify(moverCfg.cfg.desk ?? {})
    );
    check(
      "console page offers Open background desktop",
      html.includes("Open background desktop")
    );
    const DESK_MID = "desk-host-01";
    r = await fetch(`${a}/api/headless/enroll`, {
      method: "POST",
      headers: { "x-account-id": HL_ACC, "content-type": "application/json" },
      body: JSON.stringify({
        machineId: DESK_MID,
        name: "DESK-HOST",
        os: "Windows 11 Pro",
        profiles: ["USER"],
        capabilities: { desktop: true, backgroundDesktop: true }
      })
    });
    const deskEnrolled = await r.json();
    const DSECRET = deskEnrolled.machineSecret;
    const DAUTH = {
      "x-account-id": HL_ACC,
      "x-machine-id": DESK_MID,
      "x-machine-secret": DSECRET
    };
    check(
      "desk host enrolls with the backgroundDesktop capability",
      r.status === 200 && /^[0-9a-f]{64}$/.test(DSECRET ?? "")
    );

    // The operator channel (account header, no machine secret):
    // this is the door the console and the Viewer app use.
    r = await fetch(`${a}/api/headless/machines`);
    check("operator machines list without account -> 401", r.status === 401);
    r = await fetch(`${a}/api/headless/machines`, {
      headers: { "x-account-id": HL_ACC }
    });
    const opList = await r.json();
    check(
      "operator channel lists machines with a null desk session",
      r.status === 200 &&
        opList.machines?.some(
          (m) => m.machineId === DESK_MID && m.deskSession === null
        ),
      JSON.stringify(opList).slice(0, 200)
    );
    const opQueue = async (type, payload) => {
      const res = await fetch(`${a}/api/headless/commands`, {
        method: "POST",
        headers: {
          "x-account-id": HL_ACC,
          "x-machine-id": DESK_MID,
          "content-type": "application/json"
        },
        body: JSON.stringify({ type, payload })
      });
      return { status: res.status, data: await res.json() };
    };
    const postResult = async (commandId, result) =>
      fetch(`${a}/api/headless/commands/${commandId}/result`, {
        method: "POST",
        headers: { ...DAUTH, "content-type": "application/json" },
        body: JSON.stringify({ result })
      });
    const pollCmds = async () =>
      ((await (await fetch(`${a}/api/headless/commands`, { headers: DAUTH })).json()).commands ?? []);

    const deskOpenQ = await opQueue("desk-open", { width: 640, height: 400 });
    check("operator queues desk-open", deskOpenQ.status === 200 && !!deskOpenQ.data.commandId);
    let wire = await pollCmds();
    check(
      "desk-open is delivered unsigned (only start and desk-end are signed)",
      wire.length === 1 && wire[0].type === "desk-open" && !wire[0].signature,
      JSON.stringify(wire).slice(0, 200)
    );
    const SID = "desk-test-session-1";
    r = await postResult(deskOpenQ.data.commandId, {
      sessionId: SID, state: "live", openedAt: "2026-10-27T00:00:00Z", framesServed: 0
    });
    check("desk-open result posts", r.status === 200);
    r = await fetch(
      `${a}/mover/console/api/machines/${DESK_MID}/desk-session?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    const sess1 = await r.json();
    check(
      "session ledger shows the live session",
      r.status === 200 && sess1.deskSession?.state === "live" && sess1.deskSession?.sessionId === SID,
      JSON.stringify(sess1).slice(0, 200)
    );
    r = await fetch(`${a}/mover/console/api/machines?accountId=${HL_ACC}`, {
      headers: { "x-console-key": CONSOLE_KEY }
    });
    const listWithDesk = await r.json();
    check(
      "console machines list carries the live-session record (badge data)",
      listWithDesk.machines?.find((m) => m.machineId === DESK_MID)?.deskSession?.state === "live"
    );

    const deskFrameQ = await opQueue("desk-frame", {});
    wire = await pollCmds();
    r = await postResult(deskFrameQ.data.commandId, {
      data: "AAAA", seq: 1, width: 640, height: 400, framesServed: 3
    });
    check("desk-frame round trip posts", wire.length === 1 && r.status === 200);
    r = await fetch(
      `${a}/mover/console/api/machines/${DESK_MID}/desk-session?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    check(
      "frame results advance the ledger counter",
      (await r.json()).deskSession?.framesServed === 3
    );

    // The end fence: desk-end queued from the console is signed;
    // the signature verifies against the machine secret.
    const deskEndRes = await fetch(`${a}/mover/console/api/machines/${DESK_MID}/desk-end`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: HL_ACC })
    });
    const deskEndQ = { status: deskEndRes.status, data: await deskEndRes.json() };
    check(
      "console desk-end queues a signed command",
      deskEndQ.status === 200 && /^[0-9a-f]{64}$/.test(deskEndQ.data.signature ?? ""),
      JSON.stringify(deskEndQ.data)
    );
    wire = await pollCmds();
    const endCmd = wire.find((c) => c.id === deskEndQ.data.commandId);
    const expectedEndSig = createHmac("sha256", DSECRET)
      .update(JSON.stringify(canon({ id: deskEndQ.data.commandId, type: "desk-end", payload: {} })))
      .digest("hex");
    check(
      "desk-end signature verifies against canonical JSON + machine secret",
      !!endCmd && endCmd.signature === expectedEndSig,
      JSON.stringify(endCmd)
    );
    r = await postResult(deskEndQ.data.commandId, {
      sessionId: SID, state: "ended", endedBy: "admin", framesServed: 3
    });
    r = await fetch(
      `${a}/mover/console/api/machines/${DESK_MID}/desk-session?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    const sessEnded = await r.json();
    check(
      "ledger records the admin end",
      sessEnded.deskSession?.state === "ended" && sessEnded.deskSession?.endedBy === "admin",
      JSON.stringify(sessEnded).slice(0, 200)
    );

    // Idle end: a second session the engine ends on its own is
    // reported on a heartbeat and the ledger says "idle".
    const deskOpen2Q = await opQueue("desk-open", {});
    wire = await pollCmds();
    const SID2 = "desk-test-session-2";
    r = await postResult(deskOpen2Q.data.commandId, {
      sessionId: SID2, state: "live", openedAt: "2026-10-27T01:00:00Z", framesServed: 0
    });
    r = await fetch(`${a}/api/headless/heartbeat`, {
      method: "POST",
      headers: { ...DAUTH, "content-type": "application/json" },
      body: JSON.stringify({
        state: "idle",
        desk: { sessionId: SID2, state: "ended", endedBy: "idle", endedAt: "2026-10-27T01:15:00Z", framesServed: 5 }
      })
    });
    check("heartbeat carries the idle end report", r.status === 200);
    r = await fetch(
      `${a}/mover/console/api/machines/${DESK_MID}/desk-session?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    const sessIdle = await r.json();
    check(
      "ledger records the idle end",
      sessIdle.deskSession?.state === "ended" &&
        sessIdle.deskSession?.endedBy === "idle" &&
        sessIdle.deskSession?.framesServed === 5,
      JSON.stringify(sessIdle).slice(0, 200)
    );

    // The viewer page: gated like the console, carrying the viewer.
    r = await fetch(`${a}/mover/console/desk/${DESK_MID}`);
    check("desk viewer page without key -> 404", r.status === 404);
    r = await fetch(`${a}/mover/console/desk/${DESK_MID}?key=${CONSOLE_KEY}&accountId=${HL_ACC}`);
    const deskHtml = await r.text();
    check(
      "desk viewer page serves the viewer (frame, input, End session)",
      r.status === 200 &&
        deskHtml.includes("Background desktop") &&
        deskHtml.includes("End session") &&
        deskHtml.includes("desk-frame") &&
        deskHtml.includes("desk-end"),
      deskHtml.slice(0, 120)
    );

    // ---- View Screen (view) ---------------------------------------
    console.log("view screen (view)");
    check(
      "generated pair configs carry the view block",
      moverCfg.cfg.view?.enabled === true &&
        moverCfg.cfg.view?.width === 1280 &&
        moverCfg.cfg.view?.height === 720 &&
        moverCfg.cfg.view?.idleTtlSec === 900,
      JSON.stringify(moverCfg.cfg.view ?? {})
    );
    check(
      "console page offers View screen",
      html.includes("View screen")
    );
    const VIEW_MID = "view-host-01";
    r = await fetch(`${a}/api/headless/enroll`, {
      method: "POST",
      headers: { "x-account-id": HL_ACC, "content-type": "application/json" },
      body: JSON.stringify({
        machineId: VIEW_MID,
        name: "KIDS-LAPTOP",
        os: "Windows 11 Home",
        profiles: ["KID"],
        capabilities: { desktop: true, backgroundDesktop: true, viewScreen: true },
        interactiveUser: "Adaeze"
      })
    });
    const viewEnrolled = await r.json();
    const VSECRET = viewEnrolled.machineSecret;
    const VAUTH = {
      "x-account-id": HL_ACC,
      "x-machine-id": VIEW_MID,
      "x-machine-secret": VSECRET
    };
    check(
      "view host enrolls naming its signed-in user",
      r.status === 200 && /^[0-9a-f]{64}$/.test(VSECRET ?? "")
    );
    r = await fetch(`${a}/api/headless/machines`, {
      headers: { "x-account-id": HL_ACC }
    });
    const viewList = await r.json();
    check(
      "operator channel lists the machine with its user and a null view session",
      r.status === 200 &&
        viewList.machines?.some(
          (m) =>
            m.machineId === VIEW_MID &&
            m.interactiveUser === "Adaeze" &&
            m.viewSession === null
        ),
      JSON.stringify(viewList).slice(0, 300)
    );
    const opQueueV = async (type, payload) => {
      const res = await fetch(`${a}/api/headless/commands`, {
        method: "POST",
        headers: {
          "x-account-id": HL_ACC,
          "x-machine-id": VIEW_MID,
          "content-type": "application/json"
        },
        body: JSON.stringify({ type, payload })
      });
      return { status: res.status, data: await res.json() };
    };
    const postResultV = async (commandId, result) =>
      fetch(`${a}/api/headless/commands/${commandId}/result`, {
        method: "POST",
        headers: { ...VAUTH, "content-type": "application/json" },
        body: JSON.stringify({ result })
      });
    const pollCmdsV = async () =>
      ((await (await fetch(`${a}/api/headless/commands`, { headers: VAUTH })).json()).commands ?? []);

    const viewOpenQ = await opQueueV("view-open", {});
    check("operator queues view-open", viewOpenQ.status === 200 && !!viewOpenQ.data.commandId);
    let vwire = await pollCmdsV();
    check(
      "view-open is delivered unsigned (only start, desk-end and view-end are signed)",
      vwire.length === 1 && vwire[0].type === "view-open" && !vwire[0].signature,
      JSON.stringify(vwire).slice(0, 200)
    );
    const VSID = "view-test-session-1";
    r = await postResultV(viewOpenQ.data.commandId, {
      sessionId: VSID, state: "live", openedAt: "2026-10-27T02:00:00Z",
      user: "Adaeze", framesServed: 0
    });
    check("view-open result posts", r.status === 200);
    r = await fetch(
      `${a}/mover/console/api/machines/${VIEW_MID}/view-session?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    const vsess1 = await r.json();
    check(
      "view ledger shows the live view with its user",
      r.status === 200 &&
        vsess1.viewSession?.state === "live" &&
        vsess1.viewSession?.sessionId === VSID &&
        vsess1.viewSession?.user === "Adaeze" &&
        vsess1.interactiveUser === "Adaeze",
      JSON.stringify(vsess1).slice(0, 200)
    );
    const viewFrameQ = await opQueueV("view-frame", {});
    vwire = await pollCmdsV();
    r = await postResultV(viewFrameQ.data.commandId, {
      data: "BBBB", seq: 1, width: 1280, height: 720, framesServed: 4, user: "Adaeze"
    });
    check("view-frame round trip posts", vwire.length === 1 && r.status === 200);
    r = await fetch(
      `${a}/mover/console/api/machines/${VIEW_MID}/view-session?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    check(
      "view frame results advance the view ledger counter",
      (await r.json()).viewSession?.framesServed === 4
    );

    // The end fence: view-end queued from the console is signed;
    // the signature verifies against the machine secret.
    const viewEndRes = await fetch(`${a}/mover/console/api/machines/${VIEW_MID}/view-end`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: HL_ACC })
    });
    const viewEndQ = { status: viewEndRes.status, data: await viewEndRes.json() };
    check(
      "console view-end queues a signed command",
      viewEndQ.status === 200 && /^[0-9a-f]{64}$/.test(viewEndQ.data.signature ?? ""),
      JSON.stringify(viewEndQ.data)
    );
    vwire = await pollCmdsV();
    const vendCmd = vwire.find((c) => c.id === viewEndQ.data.commandId);
    const expectedViewEndSig = createHmac("sha256", VSECRET)
      .update(JSON.stringify(canon({ id: viewEndQ.data.commandId, type: "view-end", payload: {} })))
      .digest("hex");
    check(
      "view-end signature verifies against canonical JSON + machine secret",
      !!vendCmd && vendCmd.signature === expectedViewEndSig,
      JSON.stringify(vendCmd)
    );
    r = await postResultV(viewEndQ.data.commandId, {
      sessionId: VSID, state: "ended", endedBy: "admin", framesServed: 4
    });
    r = await fetch(
      `${a}/mover/console/api/machines/${VIEW_MID}/view-session?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    const vsessEnded = await r.json();
    check(
      "view ledger records the admin end",
      vsessEnded.viewSession?.state === "ended" && vsessEnded.viewSession?.endedBy === "admin",
      JSON.stringify(vsessEnded).slice(0, 200)
    );

    // Session-gone: a second view the engine ends because the
    // signed-in session went away is reported on a heartbeat and
    // the ledger says "session-gone"; the user clears with it.
    const viewOpen2Q = await opQueueV("view-open", {});
    vwire = await pollCmdsV();
    const VSID2 = "view-test-session-2";
    r = await postResultV(viewOpen2Q.data.commandId, {
      sessionId: VSID2, state: "live", openedAt: "2026-10-27T03:00:00Z",
      user: "Adaeze", framesServed: 0
    });
    r = await fetch(`${a}/api/headless/heartbeat`, {
      method: "POST",
      headers: { ...VAUTH, "content-type": "application/json" },
      body: JSON.stringify({
        state: "idle",
        interactiveUser: "",
        view: { sessionId: VSID2, state: "ended", endedBy: "session-gone", endedAt: "2026-10-27T03:10:00Z", framesServed: 7 }
      })
    });
    check("heartbeat carries the session-gone end report", r.status === 200);
    r = await fetch(
      `${a}/mover/console/api/machines/${VIEW_MID}/view-session?accountId=${HL_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    const vsessGone = await r.json();
    check(
      "view ledger records the session-gone end and the user clears",
      vsessGone.viewSession?.state === "ended" &&
        vsessGone.viewSession?.endedBy === "session-gone" &&
        vsessGone.viewSession?.framesServed === 7 &&
        vsessGone.interactiveUser === "",
      JSON.stringify(vsessGone).slice(0, 200)
    );

    // The view page: gated like the console, view-only by
    // construction (no input protocol names anywhere in it).
    r = await fetch(`${a}/mover/console/view/${VIEW_MID}`);
    check("view page without key -> 404", r.status === 404);
    r = await fetch(`${a}/mover/console/view/${VIEW_MID}?key=${CONSOLE_KEY}&accountId=${HL_ACC}`);
    const viewHtml = await r.text();
    check(
      "view page serves the view-only viewer (note, frames, End view, no input routes)",
      r.status === 200 &&
        viewHtml.includes("You are only viewing this screen") &&
        viewHtml.includes("End view") &&
        viewHtml.includes("view-frame") &&
        viewHtml.includes("view-end") &&
        !viewHtml.includes("view-input") &&
        !viewHtml.includes("desk-input"),
      viewHtml.slice(0, 120)
    );

    // ---- Files door (files) ---------------------------------------
    console.log("files door (files)");
    check(
      "generated pair configs carry the files block (enabled, empty downloadDir)",
      moverCfg.cfg.files?.enabled === true &&
        moverCfg.cfg.files?.downloadDir === "" &&
        moverCfg.cfg.messages?.filesTitle === "Files" &&
        moverCfg.cfg.messages?.filesDisabled ===
          "Files is turned off on this machine." &&
        moverCfg.cfg.messages?.filesEmpty === "No files here yet." &&
        moverCfg.cfg.messages?.filesBrowse === "Browse files" &&
        moverCfg.cfg.messages?.filesDownload === "Download" &&
        moverCfg.cfg.messages?.filesUpload === "Upload" &&
        moverCfg.cfg.messages?.filesFetchConfirm ===
          "Check this list, then confirm. Nothing moves until you confirm." &&
        moverCfg.cfg.messages?.filesPushDone ===
          "File written to the machine.",
      JSON.stringify(moverCfg.cfg.files ?? {})
    );
    check(
      "console page carries the ADMIN Files panel with its ledger",
      html.includes('id="filesMachine"') &&
        html.includes('id="filesBrowseBtn"') &&
        html.includes('id="filesReview"') &&
        html.includes('id="filesConfirmFetch"') &&
        html.includes('id="filesLedger"') &&
        html.includes("/mover/console/api/files-ledger") &&
        html.includes("Upload runs from the Viewer app only") &&
        html.includes("showFilesFor"),
      ""
    );
    const FILES_MID = "files-host-01";
    r = await fetch(`${a}/api/headless/enroll`, {
      method: "POST",
      headers: { "x-account-id": HL_ACC, "content-type": "application/json" },
      body: JSON.stringify({
        machineId: FILES_MID,
        name: "FILES-HOST",
        os: "Windows 11 Pro",
        profiles: ["USER"],
        capabilities: { desktop: true, files: true }
      })
    });
    const filesEnrolled = await r.json();
    check(
      "files host enrolls with the files capability",
      r.status === 200 &&
        /^[0-9a-f]{64}$/.test(filesEnrolled.machineSecret ?? ""),
      JSON.stringify(filesEnrolled)
    );
    const FSECRET = filesEnrolled.machineSecret;
    const FAUTH = {
      "x-account-id": HL_ACC,
      "x-machine-id": FILES_MID,
      "x-machine-secret": FSECRET
    };
    const queueFiles = async (action, body, acct = HL_ACC) => {
      const res = await fetch(
        `${a}/mover/console/api/machines/${FILES_MID}/${action}`,
        {
          method: "POST",
          headers: KH,
          body: JSON.stringify({ accountId: acct, ...body })
        }
      );
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const pollFiles = async () =>
      ((await (await fetch(`${a}/api/headless/commands`, { headers: FAUTH })).json())
        .commands ?? []);
    const postFilesResult = (commandId, result) =>
      fetch(`${a}/api/headless/commands/${commandId}/result`, {
        method: "POST",
        headers: { ...FAUTH, "content-type": "application/json" },
        body: JSON.stringify({ result })
      });

    const fbrowseQ = await queueFiles("files-browse", {
      prefix: "docs",
      offset: 0,
      limit: 50
    });
    check(
      "console files-browse queues a command",
      fbrowseQ.status === 200 &&
        /^cmd-[0-9a-f]{20}$/.test(fbrowseQ.data.commandId ?? ""),
      JSON.stringify(fbrowseQ.data)
    );
    const fwire1 = await pollFiles();
    check(
      "files-browse arrives unsigned with its payload",
      fwire1.length === 1 &&
        fwire1[0].id === fbrowseQ.data.commandId &&
        fwire1[0].type === "files-browse" &&
        fwire1[0].payload?.prefix === "docs" &&
        fwire1[0].payload?.offset === 0 &&
        fwire1[0].payload?.limit === 50 &&
        !("signature" in fwire1[0]),
      JSON.stringify(fwire1).slice(0, 200)
    );

    const ffetchEmpty = await queueFiles("files-fetch", {
      moveName: "Files from FILES-HOST",
      paths: []
    });
    check(
      "files-fetch with empty paths -> 400 EMPTY_SELECTION",
      ffetchEmpty.status === 400 &&
        ffetchEmpty.data.error === "EMPTY_SELECTION",
      JSON.stringify(ffetchEmpty.data)
    );
    const ffetchNonList = await queueFiles("files-fetch", {
      moveName: "Files from FILES-HOST",
      paths: "docs/a.txt"
    });
    check(
      "files-fetch with a non-list paths -> 400 EMPTY_SELECTION",
      ffetchNonList.status === 400 &&
        ffetchNonList.data.error === "EMPTY_SELECTION",
      JSON.stringify(ffetchNonList.data)
    );
    const fpushBad = await queueFiles("files-push", {
      moveId: "move-files-1"
    });
    check(
      "files-push with missing destDir -> 400 BAD_FILES_PAYLOAD",
      fpushBad.status === 400 && fpushBad.data.error === "BAD_FILES_PAYLOAD",
      JSON.stringify(fpushBad.data)
    );

    const fetchPayload = {
      moveName: "Files from FILES-HOST",
      paths: ["docs/a.txt", "docs/b.bin"]
    };
    const ffetchQ = await queueFiles("files-fetch", fetchPayload);
    check(
      "console files-fetch queues a signed command",
      ffetchQ.status === 200 &&
        /^[0-9a-f]{64}$/.test(ffetchQ.data.signature ?? ""),
      JSON.stringify(ffetchQ.data)
    );
    const fwire2 = await pollFiles();
    const ffetchCmd = fwire2.find((c) => c.id === ffetchQ.data.commandId);
    const expectedFetchSig = createHmac("sha256", FSECRET)
      .update(
        JSON.stringify(
          canon({
            id: ffetchQ.data.commandId,
            type: "files-fetch",
            payload: fetchPayload
          })
        )
      )
      .digest("hex");
    check(
      "files-fetch signature verifies against canonical JSON + machine secret",
      !!ffetchCmd &&
        ffetchCmd.type === "files-fetch" &&
        ffetchCmd.signature === expectedFetchSig &&
        ffetchCmd.signature === ffetchQ.data.signature,
      JSON.stringify(ffetchCmd)
    );

    const pushPayload = { moveId: "move-files-1", destDir: "C:/Incoming" };
    const fpushQ = await queueFiles("files-push", pushPayload);
    check(
      "console files-push queues a signed command",
      fpushQ.status === 200 &&
        /^[0-9a-f]{64}$/.test(fpushQ.data.signature ?? ""),
      JSON.stringify(fpushQ.data)
    );
    const fwire3 = await pollFiles();
    const fpushCmd = fwire3.find((c) => c.id === fpushQ.data.commandId);
    const expectedPushSig = createHmac("sha256", FSECRET)
      .update(
        JSON.stringify(
          canon({
            id: fpushQ.data.commandId,
            type: "files-push",
            payload: pushPayload
          })
        )
      )
      .digest("hex");
    check(
      "files-push signature verifies against canonical JSON + machine secret",
      !!fpushCmd &&
        fpushCmd.type === "files-push" &&
        fpushCmd.signature === expectedPushSig &&
        fpushCmd.signature === fpushQ.data.signature,
      JSON.stringify(fpushCmd)
    );

    r = await postFilesResult(ffetchQ.data.commandId, {
      transfers: [
        { direction: "download", path: "docs/a.txt", size: 5, outcome: "ok" },
        { direction: "download", path: "docs/b.bin", size: 7, outcome: "ok" }
      ]
    });
    check("files-fetch result with transfers posts", r.status === 200);
    r = await fetch(`${a}/mover/console/api/files-ledger`);
    check("files-ledger without key -> 404", r.status === 404);
    r = await fetch(`${a}/mover/console/api/files-ledger`, {
      headers: { "x-console-key": CONSOLE_KEY }
    });
    const ledger = await r.json();
    check(
      "files-fetch transfers fold into the ledger (newest first, full record shape)",
      r.status === 200 &&
        ledger.records?.length === 2 &&
        ledger.records[0].path === "docs/b.bin" &&
        ledger.records[0].direction === "download" &&
        ledger.records[0].size === 7 &&
        ledger.records[0].outcome === "ok" &&
        ledger.records[0].machineId === FILES_MID &&
        ledger.records[0].accountId === HL_ACC &&
        typeof ledger.records[0].at === "string" &&
        ledger.records[1].path === "docs/a.txt" &&
        ledger.records[1].size === 5 &&
        ledger.records[1].machineId === FILES_MID,
      JSON.stringify(ledger).slice(0, 300)
    );

    // License gating: revoke the test account (all products), and
    // fetch/push queueing must block while browse stays open;
    // restoring every license reopens the fetch.
    const FILES_REVOKED_ACC = "mv67c7c1a8916a988e0000";
    r = await fetch(`${a}/api/headless/enroll`, {
      method: "POST",
      headers: {
        "x-account-id": FILES_REVOKED_ACC,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        machineId: FILES_MID,
        name: "FILES-HOST-ASSISTANT",
        capabilities: { files: true }
      })
    });
    check(
      "files machine enrolls under the test account before revoking",
      r.status === 200,
      `got ${r.status}`
    );
    const licChangeFiles = async (action, product) => {
      const res = await fetch(`${a}/mover/console/api/licenses/${action}`, {
        method: "POST",
        headers: KH,
        body: JSON.stringify({ product, accountId: FILES_REVOKED_ACC })
      });
      return res.status;
    };
    const revokeCodes = [];
    for (const p of ["ext", "mover", "admin"]) {
      revokeCodes.push(await licChangeFiles("revoke", p));
    }
    check(
      "test account licenses revoked for all products (files gate setup)",
      revokeCodes.every((s) => s === 200),
      JSON.stringify(revokeCodes)
    );
    const fbrowseRevoked = await queueFiles(
      "files-browse",
      { prefix: "docs" },
      FILES_REVOKED_ACC
    );
    check(
      "files-browse stays ungated for a revoked account (read only)",
      fbrowseRevoked.status === 200 && !!fbrowseRevoked.data.commandId,
      JSON.stringify(fbrowseRevoked.data)
    );
    const ffetchRevoked = await queueFiles(
      "files-fetch",
      fetchPayload,
      FILES_REVOKED_ACC
    );
    check(
      "files-fetch for a revoked account -> 403 LICENSE_REVOKED",
      ffetchRevoked.status === 403 &&
        ffetchRevoked.data.error === "LICENSE_REVOKED",
      JSON.stringify(ffetchRevoked.data)
    );
    const fpushRevoked = await queueFiles(
      "files-push",
      pushPayload,
      FILES_REVOKED_ACC
    );
    check(
      "files-push for a revoked account -> 403 LICENSE_REVOKED",
      fpushRevoked.status === 403 &&
        fpushRevoked.data.error === "LICENSE_REVOKED",
      JSON.stringify(fpushRevoked.data)
    );
    const restoreCodes = [];
    for (const p of ["ext", "mover", "admin"]) {
      restoreCodes.push(await licChangeFiles("restore", p));
    }
    check(
      "test account licenses restored for all products",
      restoreCodes.every((s) => s === 200),
      JSON.stringify(restoreCodes)
    );
    const ffetchReopened = await queueFiles(
      "files-fetch",
      fetchPayload,
      FILES_REVOKED_ACC
    );
    check(
      "files-fetch queues again once the licenses are restored",
      ffetchReopened.status === 200 &&
        /^[0-9a-f]{64}$/.test(ffetchReopened.data.signature ?? ""),
      JSON.stringify(ffetchReopened.data)
    );

    // ---- Licenses, unified console, host + viewer builds ---------
    console.log("licenses + unified console");
    const OWNER_ACC = "mv79ce74e43cc48d276ca0";
    const ASSISTANT_ACC = "mv67c7c1a8916a988e0000";
    const licApi = async (method, pathSuffix, body) => {
      const res = await fetch(`${a}/mover/console/api/licenses${pathSuffix}`, {
        method,
        headers: KH,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };

    check(
      "console page is the tabbed shell (Relayn Console, EXT, MOVER, ADMIN tabs)",
      html.includes("<h1>Relayn Console</h1>") &&
        html.includes('data-tab="overview"') &&
        html.includes('data-tab="ext"') &&
        html.includes('data-tab="mover"') &&
        html.includes('data-tab="admin"') &&
        html.includes(">EXT<") &&
        html.includes(">MOVER<") &&
        html.includes(">ADMIN<")
    );
    r = await fetch(`${a}/mover/console/api/licenses`);
    check("licenses list without key -> 404", r.status === 404);
    r = await fetch(`${a}/mover/console/api/overview`);
    check("overview without key -> 404", r.status === 404);

    const allLic = await licApi("GET", "");
    const seededFor = (acct, product) =>
      allLic.data.licenses?.find(
        (l) => l.accountId === acct && l.product === product
      );
    check(
      "seeded owner licenses are active for all three products",
      allLic.status === 200 &&
        ["ext", "mover", "admin"].every(
          (p) =>
            seededFor(OWNER_ACC, p)?.status === "active" &&
            seededFor(OWNER_ACC, p)?.label === "Owner"
        ),
      JSON.stringify(allLic.data).slice(0, 200)
    );
    check(
      "seeded assistant licenses are active for all three products",
      ["ext", "mover", "admin"].every(
        (p) =>
          seededFor(ASSISTANT_ACC, p)?.status === "active" &&
          seededFor(ASSISTANT_ACC, p)?.label === "Assistant test pair"
      )
    );
    check(
      "the console-created pair holds mover + admin licenses (Console pair)",
      seededFor(pair.accountId, "mover")?.label === "Console pair" &&
        seededFor(pair.accountId, "admin")?.label === "Console pair"
    );
    const extOnly = await licApi("GET", "?product=ext");
    check(
      "licenses list filters by product",
      extOnly.status === 200 &&
        extOnly.data.licenses?.length > 0 &&
        extOnly.data.licenses.every((l) => l.product === "ext")
    );

    const issuedFresh = await licApi("POST", "", {
      product: "ext",
      label: "Fresh shop",
      note: "issued by the test"
    });
    check(
      "issuing without an account mints an mv account and returns the license",
      issuedFresh.status === 200 &&
        /^mv[0-9a-f]{20}$/.test(issuedFresh.data.accountId ?? "") &&
        issuedFresh.data.product === "ext" &&
        issuedFresh.data.status === "active" &&
        issuedFresh.data.label === "Fresh shop",
      JSON.stringify(issuedFresh.data)
    );
    const afterIssue = await licApi("GET", "?product=ext");
    check(
      "the freshly issued license shows in the list",
      afterIssue.data.licenses?.some(
        (l) => l.accountId === issuedFresh.data.accountId
      )
    );
    const issuedNamed = await licApi("POST", "", {
      product: "mover",
      accountId: "mvfreshtest000001",
      label: "Named account"
    });
    check(
      "issuing for a named fresh account works",
      issuedNamed.status === 200 &&
        issuedNamed.data.accountId === "mvfreshtest000001" &&
        issuedNamed.data.status === "active"
    );

    // Host and viewer builds: admin-side roles, empty feature set.
    const hostCfg = await getConfig("host");
    const viewerCfg = await getConfig("viewer");
    check(
      "host config: role host, empty features, headless + desk + view blocks",
      hostCfg.status === 200 &&
        hostCfg.cfg.role === "host" &&
        hostCfg.cfg.features.move === false &&
        hostCfg.cfg.features.inbox === false &&
        hostCfg.cfg.features.import === false &&
        hostCfg.cfg.headless?.enroll === true &&
        hostCfg.cfg.desk?.enabled === true &&
        hostCfg.cfg.view?.enabled === true,
      JSON.stringify(hostCfg.cfg).slice(0, 200)
    );
    check(
      "viewer config: role viewer, empty features",
      viewerCfg.status === 200 &&
        viewerCfg.cfg.role === "viewer" &&
        viewerCfg.cfg.features.move === false &&
        viewerCfg.cfg.features.inbox === false &&
        viewerCfg.cfg.features.import === false
    );
    r = await fetch(`${a}/mover/console/api/package`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: pair.accountId, role: "host" })
    });
    check(
      "host build filename is relayn-host.exe",
      r.status === 200 &&
        (r.headers.get("content-disposition") ?? "").includes(
          'filename="relayn-host.exe"'
        ),
      r.headers.get("content-disposition") ?? ""
    );
    r = await fetch(`${a}/mover/console/api/package`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: pair.accountId, role: "viewer" })
    });
    check(
      "viewer build filename is relayn-admin-viewer.exe",
      r.status === 200 &&
        (r.headers.get("content-disposition") ?? "").includes(
          'filename="relayn-admin-viewer.exe"'
        ),
      r.headers.get("content-disposition") ?? ""
    );

    // Overview + moves across known accounts. Announce a move under
    // the pair account (a known account) so it must show up.
    const ovManifest = {
      moveId: "move-console-overview-1",
      name: "Overview move",
      totalBytes: 5,
      totalFiles: 1,
      chunks: [{ index: 0, path: "files/a.txt", offset: 0, size: 5, sha256: "x" }]
    };
    r = await fetch(`${a}/api/moves`, {
      method: "POST",
      headers: {
        "x-account-id": HL_ACC,
        "content-type": "application/json"
      },
      body: JSON.stringify({ moverName: "RETIRE-ME", manifest: ovManifest })
    });
    check("announce under the pair account ok", r.status === 200);
    r = await fetch(`${a}/mover/console/api/moves`, {
      headers: { "x-console-key": CONSOLE_KEY }
    });
    const movesData = await r.json();
    check(
      "console moves lists moves across known accounts with the account field",
      r.status === 200 &&
        movesData.moves?.some(
          (m) => m.moveId === ovManifest.moveId && m.account === HL_ACC
        ),
      JSON.stringify(movesData).slice(0, 200)
    );
    r = await fetch(`${a}/mover/console/api/overview`, {
      headers: { "x-console-key": CONSOLE_KEY }
    });
    const overview = await r.json();
    check(
      "overview carries licenses, counts, machines, moves, presence and ext activity",
      r.status === 200 &&
        Array.isArray(overview.licenses) &&
        overview.licenseCounts?.ext?.active >= 2 &&
        overview.licenseCounts?.mover?.active >= 2 &&
        Array.isArray(overview.machines) &&
        overview.machines.some((m) => m.account === HL_ACC) &&
        overview.moves?.some((m) => m.moveId === ovManifest.moveId) &&
        Array.isArray(overview.presence?.[HL_ACC]) &&
        typeof overview.ext?.livePayloads === "number" &&
        typeof overview.ext?.backups === "number" &&
        Array.isArray(overview.ext?.accountShares?.[HL_ACC]),
      JSON.stringify(overview).slice(0, 200)
    );

    // Revoke the assistant account everywhere: enroll and downloads
    // for its products must block, then restore must open them again.
    for (const p of ["ext", "mover", "admin"]) {
      const rv = await licApi("POST", "/revoke", {
        product: p,
        accountId: ASSISTANT_ACC
      });
      check(
        `revoke assistant ${p} license -> revoked`,
        rv.status === 200 && rv.data.status === "revoked",
        JSON.stringify(rv.data)
      );
    }
    const revokeGhost = await licApi("POST", "/revoke", {
      product: "ext",
      accountId: "mvunknownacct01"
    });
    check(
      "revoking an unknown license -> 404 LICENSE_NOT_FOUND",
      revokeGhost.status === 404 &&
        revokeGhost.data.error === "LICENSE_NOT_FOUND",
      JSON.stringify(revokeGhost.data)
    );
    r = await fetch(`${a}/api/headless/enroll`, {
      method: "POST",
      headers: {
        "x-account-id": ASSISTANT_ACC,
        "content-type": "application/json"
      },
      body: JSON.stringify({ machineId: "revoked-machine-01", name: "BLOCKED" })
    });
    const enrollBlocked = await r.json().catch(() => ({}));
    check(
      "enroll for a revoked account -> 403 LICENSE_REVOKED",
      r.status === 403 && enrollBlocked.error === "LICENSE_REVOKED",
      `got ${r.status} ${JSON.stringify(enrollBlocked)}`
    );
    r = await fetch(`${a}/mover/console/api/config`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: ASSISTANT_ACC, role: "mover" })
    });
    const cfgBlocked = await r.json().catch(() => ({}));
    check(
      "config download for revoked mover account -> 403 LICENSE_REVOKED",
      r.status === 403 && cfgBlocked.error === "LICENSE_REVOKED",
      `got ${r.status}`
    );
    r = await fetch(`${a}/mover/console/api/package`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: ASSISTANT_ACC, role: "admin" })
    });
    const pkgBlocked = await r.json().catch(() => ({}));
    check(
      "package download for revoked admin account -> 403 LICENSE_REVOKED",
      r.status === 403 && pkgBlocked.error === "LICENSE_REVOKED",
      `got ${r.status}`
    );
    r = await fetch(`${a}/mover/console/api/package`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: ASSISTANT_ACC, role: "host" })
    });
    check(
      "host download is gated by the admin license too -> 403",
      r.status === 403,
      `got ${r.status}`
    );

    const restoreMover = await licApi("POST", "/restore", {
      product: "mover",
      accountId: ASSISTANT_ACC
    });
    check(
      "restore mover license -> active",
      restoreMover.status === 200 && restoreMover.data.status === "active"
    );
    r = await fetch(`${a}/mover/console/api/config`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: ASSISTANT_ACC, role: "mover" })
    });
    check(
      "config download works again for the restored product",
      r.status === 200,
      `got ${r.status}`
    );
    for (const p of ["ext", "admin"]) {
      await licApi("POST", "/restore", {
        product: p,
        accountId: ASSISTANT_ACC
      });
    }
    r = await fetch(`${a}/api/headless/enroll`, {
      method: "POST",
      headers: {
        "x-account-id": ASSISTANT_ACC,
        "content-type": "application/json"
      },
      body: JSON.stringify({ machineId: "revoked-machine-01", name: "ALLOWED-AGAIN" })
    });
    const enrollAgain = await r.json().catch(() => ({}));
    check(
      "enroll succeeds again once every license is restored",
      r.status === 200 &&
        /^[0-9a-f]{64}$/.test(enrollAgain.machineSecret ?? ""),
      `got ${r.status} ${JSON.stringify(enrollAgain)}`
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
    // EXT pair flow: defaults, merged config, ready build zips,
    // validation, license gating.
    // ---------------------------------------------------------------
    const extApi = async (method, suffix, body, headers = KH) => {
      const res = await fetch(`${a}/mover/console/api/ext${suffix}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return res;
    };

    r = await fetch(`${a}/mover/console/api/ext/defaults`);
    check("EXT defaults without key -> 404", r.status === 404);

    r = await extApi("GET", "/defaults");
    const extDefaults = (await r.json()).config;
    check(
      "EXT defaults are the shipped pair config (brand, 63 messages)",
      r.status === 200 &&
        extDefaults.brand.name === "Relayn" &&
        Object.keys(extDefaults.messages).length === 63 &&
        extDefaults.features.share === true,
      `got ${r.status}`
    );

    r = await extApi("POST", "/config", {
      accountId: extDefaults.account.id,
      role: "admin"
    });
    const roundTrip = await r.json();
    check(
      "EXT defaults round trip: config download equals the defaults",
      r.status === 200 && sameJson(roundTrip, extDefaults),
      `got ${r.status}`
    );

    r = await extApi("POST", "/config", { accountId: OWNER_ACC, role: "child" });
    const childCfg = await r.json();
    check(
      "EXT child config is share-only with the pair account linked",
      r.status === 200 &&
        childCfg.features.share === true &&
        childCfg.features.scan === false &&
        childCfg.features.inbox === false &&
        childCfg.account.id === OWNER_ACC,
      `got ${r.status} ${JSON.stringify(childCfg.features || {})}`
    );

    r = await extApi("POST", "/package", {
      accountId: OWNER_ACC,
      role: "child",
      brand: { name: "Acme Sessions" },
      features: { history: false },
      messages: { statusReady: "All set." }
    });
    const zipBuf = Buffer.from(await r.arrayBuffer());
    const zip = readZip(zipBuf);
    let zipCfg = null;
    try {
      zipCfg = JSON.parse(zip["config.json"].toString("utf8"));
    } catch {
      zipCfg = null;
    }
    check(
      "EXT package is a zip carrying the full staged file set",
      r.status === 200 &&
        zip !== null &&
        ["config.json", "manifest.json", "background.js", "content.js",
          "popup.html", "popup.js", "README.md", "qrcode.min.js", "jsQR.min.js"]
          .every((name) => zip[name] && zip[name].length > 0),
      `got ${r.status}`
    );
    check(
      "EXT package config carries the edited values",
      zipCfg !== null &&
        zipCfg.brand.name === "Acme Sessions" &&
        zipCfg.features.history === false &&
        zipCfg.features.scan === false &&
        zipCfg.messages.statusReady === "All set." &&
        zipCfg.account.id === OWNER_ACC,
      JSON.stringify(zipCfg && zipCfg.brand)
    );
    const stagedBg = readFileSync(
      path.join(serverDir, "assets", "ext", "background.js")
    );
    check(
      "EXT package ships the staged extension bytes untouched",
      zip !== null && zip["background.js"].equals(stagedBg)
    );

    r = await extApi("POST", "/config", {
      accountId: OWNER_ACC, role: "child",
      brand: { primaryColor: "red" }
    });
    check(
      "EXT config with a bad colour -> 400 INVALID_CONFIG",
      r.status === 400 && (await r.json()).error === "INVALID_CONFIG",
      `got ${r.status}`
    );
    r = await extApi("POST", "/config", {
      accountId: OWNER_ACC, role: "child",
      serverUrl: "https://example.com/some/path"
    });
    check(
      "EXT config with a pathed server URL -> 400 INVALID_CONFIG",
      r.status === 400 && (await r.json()).error === "INVALID_CONFIG",
      `got ${r.status}`
    );
    r = await extApi("POST", "/config", {
      accountId: OWNER_ACC, role: "child",
      messages: { noSuchMessage: "x" }
    });
    check(
      "EXT config with an unknown message key -> 400 INVALID_CONFIG",
      r.status === 400 && (await r.json()).error === "INVALID_CONFIG",
      `got ${r.status}`
    );
    r = await extApi("POST", "/config", { accountId: "bad!", role: "child" });
    check(
      "EXT config with a bad account ID -> 400 INVALID_ACCOUNT",
      r.status === 400 && (await r.json()).error === "INVALID_ACCOUNT",
      `got ${r.status}`
    );

    r = await extApi("POST", "/pairs", {});
    const extPair = await r.json();
    check(
      "EXT pair creation mints an account and issues its EXT license",
      r.status === 200 &&
        /^mv[0-9a-f]{20}$/.test(extPair.accountId || "") &&
        (await licApi("GET", "?product=ext")).data.licenses?.some(
          (l) => l.accountId === extPair.accountId && l.label === "Console EXT pair"
        ),
      `got ${r.status} ${JSON.stringify(extPair)}`
    );

    const gateLic = await licApi("POST", "/revoke", {
      product: "ext",
      accountId: ASSISTANT_ACC
    });
    r = await extApi("POST", "/config", { accountId: ASSISTANT_ACC, role: "child" });
    check(
      "EXT download for a revoked account -> 403 LICENSE_REVOKED",
      gateLic.status === 200 &&
        r.status === 403 &&
        (await r.json()).error === "LICENSE_REVOKED",
      `got ${r.status}`
    );
    await licApi("POST", "/restore", { product: "ext", accountId: ASSISTANT_ACC });
    r = await extApi("POST", "/config", { accountId: ASSISTANT_ACC, role: "child" });
    check(
      "EXT download works again after the license is restored",
      r.status === 200,
      `got ${r.status}`
    );

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
