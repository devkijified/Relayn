// =========================================================================
// Relayn server - local endpoint tests (no framework, plain fetch).
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
//   * the Partition routes: status, rebuild (bind by machineId or
//     enrolled name, unbound moves named), browse, document (refs
//     only), wallpaper, desktop-icons, pins, mutate (confirmed:true
//     required, every op other than delete/rename refused by name,
//     path + newName + machineId validation, folder delete/rename),
//     ledger (ordered, account-scoped, read back after a restart),
//     sealed manifests untouched, nothing queued for the source
//   * the durable store: every store written through to
//     <MOVER_DATA_DIR>/state/ and reloaded at boot — an instance
//     is SIGKILLed (no shutdown flush) and its successor on the
//     same data dir reads back the enrollment + secret, a queued
//     command, live and spent shares, a backup, a move, a
//     partition ledger entry, and a license revocation that
//     still gates enrollment
// Run:  node tests/relayn-server.test.mjs
// =========================================================================

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  "stdio": ["ignore", "pipe", "pipe"],
    // Own process group: tsx forks the real server as a grandchild,
    // so a signal to the tsx wrapper alone orphans the server.
    detached: true
  });
  child.stderr.on("data", (d) => process.stderr.write(`[srv ${port}] ${d}`));
  return child;
}

// Signal the whole group (tsx wrapper + the server it forked).
function killTree(child, sig) {
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
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
    // boots paired on the inbuilt config - no sidecar, no warning.
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
    const pollBody0 = await r.json().catch(() => null);
    check(
      "command poll starts empty, as a bare top-level array (the protocol contract)",
      r.status === 200 && Array.isArray(pollBody0) && pollBody0.length === 0,
      JSON.stringify(pollBody0).slice(0, 120)
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

    // Session evidence + poll health: the heartbeat carries who
    // is signed in, whether the pick is away, the compact
    // session diagnostic, and the last command poll's outcome;
    // the record folds all four and the console list serves
    // them, so a deaf or away machine never reads as a bare
    // "idle" with "no one" signed in.
    r = await beat(MAUTH, {
      state: "idle",
      interactiveUser: "Administrator",
      interactiveAway: true,
      sessions: { users: 1, active: 0, connected: 0, disconnected: 1, other: 0, picked: 2, away: true },
      poll: { ok: false, error: "the server does not know this machine", at: "2026-10-27T17:00:00Z" }
    });
    const sessBeatOk = r.status === 200;
    r = await fetch(`${a}/mover/console/api/machines?accountId=${HL_ACC}`, {
      headers: { "x-console-key": CONSOLE_KEY }
    });
    const sessList = await r.json();
    const sessRow = (sessList.machines ?? []).find((m) => m.machineId === HL_MID);
    check(
      "session evidence folds from heartbeat into the machines list",
      sessBeatOk && !!sessRow &&
        sessRow.interactiveUser === "Administrator" &&
        sessRow.interactiveAway === true &&
        sessRow.sessionsDiag?.users === 1 &&
        sessRow.sessionsDiag?.disconnected === 1 &&
        sessRow.sessionsDiag?.picked === 2 &&
        sessRow.sessionsDiag?.away === true,
      JSON.stringify(sessRow ?? {}).slice(0, 240)
    );
    check(
      "poll health folds from heartbeat into the machines list",
      !!sessRow && sessRow.pollOk === false &&
        sessRow.pollError === "the server does not know this machine" &&
        sessRow.pollAt === "2026-10-27T17:00:00Z",
      JSON.stringify(sessRow ?? {}).slice(0, 240)
    );
    r = await beat(MAUTH, {
      state: "idle",
      interactiveUser: "Administrator",
      interactiveAway: false,
      sessions: { users: "many", active: -3 },
      poll: { ok: true, error: "", at: "2026-10-27T17:01:00Z" }
    });
    r = await fetch(`${a}/mover/console/api/machines?accountId=${HL_ACC}`, {
      headers: { "x-console-key": CONSOLE_KEY }
    });
    const sessRow2 = ((await r.json()).machines ?? []).find((m) => m.machineId === HL_MID);
    check(
      "a malformed session diagnostic is refused (last good kept), away and poll clear",
      !!sessRow2 && sessRow2.interactiveAway === false &&
        sessRow2.sessionsDiag?.disconnected === 1 &&
        sessRow2.pollOk === true && sessRow2.pollError === "",
      JSON.stringify(sessRow2 ?? {}).slice(0, 240)
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
      polled.length === 1 &&
        polled[0].id === scanQueued.commandId &&
        polled[0].type === "scan" &&
        !("signature" in polled[0])
    );
    r = await fetch(`${a}/api/headless/commands`, { headers: MAUTH });
    check("command poll clears the queue", (await r.json()).length === 0);
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
    const cmds2 = (await r.json()) ?? [];
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
    const startCmd = ((await r.json()) ?? [])[0];
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
    const rePolled = (await r.json()) ?? [];
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
      r.status === 200 && (await r.json()).length === 0
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
      ((await (await fetch(`${a}/api/headless/commands`, { headers: DAUTH })).json()) ?? []);

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
      ((await (await fetch(`${a}/api/headless/commands`, { headers: VAUTH })).json()) ?? []);

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
      ((await (await fetch(`${a}/api/headless/commands`, { headers: FAUTH })).json()) ?? []);
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

    // ---- Anchor: build endpoint, update queueing, folds ---------
    console.log("anchor");
    check(
      "console page carries the anchor panel and ledger",
      html.includes('id="anchorPanel"') &&
        html.includes('id="anchorLedger"') &&
        html.includes("/mover/console/api/anchor-ledger") &&
        html.includes("Update Host to build") &&
        html.includes("Anchor ledger") &&
        html.includes("askAnchorUpdate"),
      ""
    );
    // The generated config carries the anchor block at the apps'
    // defaults (Go config defaults: enabled, data-dir suite,
    // 120 second proof window).
    r = await fetch(`${a}/mover/console/api/config`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({ accountId: HL_ACC, role: "host" })
    });
    const anchorHostCfg = await r.json();
    check(
      "host config carries the anchor block at its defaults",
      r.status === 200 &&
        anchorHostCfg.anchor?.enabled === true &&
        anchorHostCfg.anchor?.suiteDir === "" &&
        anchorHostCfg.anchor?.updateProofSec === 120,
      JSON.stringify(anchorHostCfg.anchor ?? {})
    );
    // Instance A serves an unstamped base: no update can be
    // ordered (the exact-target rule refuses before queueing).
    const noStampUpd = await fetch(
      `${a}/mover/console/api/machines/any-machine/anchor-update`,
      {
        method: "POST",
        headers: KH,
        body: JSON.stringify({ accountId: HL_ACC, stamp: "209901010000" })
      }
    );
    const noStampData = await noStampUpd.json().catch(() => ({}));
    check(
      "anchor-update with no stamped build served -> 400 STAMP_MISMATCH",
      noStampUpd.status === 400 && noStampData.error === "STAMP_MISMATCH",
      JSON.stringify(noStampData)
    );

    // Instance D: the base exe is a stamped fixture (the real
    // base bytes plus a future stamp string appended; the
    // content scan takes the largest plausible stamp, which is
    // the appended one on this fixture).
    const ANCHOR_ACC = "anchortest01";
    const SERVED_STAMP = "209901010000";
    const fixturePath = path.join(dataDir, "fixture-base.exe");
    writeFileSync(
      fixturePath,
      Buffer.concat([
        readFileSync(BASE_EXE),
        Buffer.from(`\n${SERVED_STAMP}\n`, "ascii")
      ])
    );
    const D = 4420;
    children.push(
      boot(D, {
        MOVER_DATA_DIR: `${dataDir}-d`,
        MOVER_CONSOLE_KEY: CONSOLE_KEY,
        MOVER_BASE_EXE: fixturePath
      })
    );
    check("instance D boots (stamped fixture base)", await waitHealth(D));
    const d = `http://127.0.0.1:${D}`;
    const AMID = "anchor-host-01";
    r = await fetch(`${d}/api/headless/enroll`, {
      method: "POST",
      headers: { "x-account-id": ANCHOR_ACC, "content-type": "application/json" },
      body: JSON.stringify({
        machineId: AMID,
        name: "ANCHOR-HOST",
        os: "Windows Server 2022",
        profiles: ["Administrator"],
        capabilities: { desktop: true, anchor: true },
        buildStamp: "202601010000"
      })
    });
    const anchorEnrolled = await r.json();
    check(
      "anchor host enrolls carrying its build stamp",
      r.status === 200 &&
        /^[0-9a-f]{64}$/.test(anchorEnrolled.machineSecret ?? ""),
      JSON.stringify(anchorEnrolled)
    );
    const ASECRET = anchorEnrolled.machineSecret;
    const AAUTH = {
      "x-account-id": ANCHOR_ACC,
      "x-machine-id": AMID,
      "x-machine-secret": ASECRET
    };
    // Issue the account's admin license up front: the console
    // ledgers read across known (licensed or paired) accounts,
    // the files ledger's rule, and the gate test below needs a
    // license to revoke.
    const issueD = await fetch(`${d}/mover/console/api/licenses`, {
      method: "POST",
      headers: KH,
      body: JSON.stringify({
        product: "admin",
        accountId: ANCHOR_ACC,
        label: "Anchor test"
      })
    });
    check(
      "anchor test account admin license issued (setup)",
      issueD.status === 200,
      `got ${issueD.status}`
    );
    r = await fetch(`${d}/api/headless/build?role=host`, {
      headers: { ...AAUTH, "x-machine-secret": "wrong-secret" }
    });
    check("build download with a bad secret -> 401", r.status === 401);
    r = await fetch(`${d}/api/headless/build?role=bogus`, { headers: AAUTH });
    check("build download with a bad role -> 400", r.status === 400);
    r = await fetch(`${d}/api/headless/build?role=host`, { headers: AAUTH });
    const builtBody = Buffer.from(await r.arrayBuffer());
    const overlayAt = builtBody.lastIndexOf("RLNMCFG1");
    const overlayLen =
      overlayAt >= 4 ? builtBody.readUInt32LE(overlayAt - 4) : 0;
    const overlayCfg = JSON.parse(
      builtBody.toString("utf8", overlayAt - 4 - overlayLen, overlayAt - 4)
    );
    check(
      "build download serves the stamped build for the machine's own account",
      r.status === 200 &&
        r.headers.get("x-build-stamp") === SERVED_STAMP &&
        Number(r.headers.get("x-build-size")) === builtBody.length &&
        overlayCfg.account?.id === ANCHOR_ACC &&
        overlayCfg.role === "host" &&
        overlayCfg.anchor?.enabled === true,
      `stamp ${r.headers.get("x-build-stamp")} size ${r.headers.get("x-build-size")} overlay ${JSON.stringify(overlayCfg.account ?? {})}/${overlayCfg.role ?? ""}`
    );
    r = await fetch(
      `${d}/mover/console/api/machines?accountId=${ANCHOR_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    const dMachines = await r.json();
    const dRow = (dMachines.machines ?? []).find((m) => m.machineId === AMID);
    check(
      "console machines list carries the served stamp and the machine's build stamp",
      r.status === 200 &&
        dMachines.buildStamp === SERVED_STAMP &&
        dRow?.buildStamp === "202601010000" &&
        dRow?.anchorLast === null,
      JSON.stringify({ served: dMachines.buildStamp, row: dRow?.buildStamp })
    );
    const queueAnchor = async (action, body) => {
      const res = await fetch(
        `${d}/mover/console/api/machines/${AMID}/${action}`,
        {
          method: "POST",
          headers: KH,
          body: JSON.stringify({ accountId: ANCHOR_ACC, ...body })
        }
      );
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const wrongStamp = await queueAnchor("anchor-update", {
      stamp: "202601020000"
    });
    check(
      "anchor-update naming a stamp the server does not serve -> 400 STAMP_MISMATCH",
      wrongStamp.status === 400 && wrongStamp.data.error === "STAMP_MISMATCH",
      JSON.stringify(wrongStamp.data)
    );
    const updQ = await queueAnchor("anchor-update", { stamp: SERVED_STAMP });
    check(
      "console anchor-update queues a signed command for the served stamp",
      updQ.status === 200 &&
        /^[0-9a-f]{64}$/.test(updQ.data.signature ?? ""),
      JSON.stringify(updQ.data)
    );
    const awire = await (
      await fetch(`${d}/api/headless/commands`, { headers: AAUTH })
    ).json();
    const updCmd = (awire ?? []).find((c) => c.id === updQ.data.commandId);
    const expectedUpdSig = createHmac("sha256", ASECRET)
      .update(
        JSON.stringify(
          canon({
            id: updQ.data.commandId,
            type: "anchor-update",
            payload: { stamp: SERVED_STAMP }
          })
        )
      )
      .digest("hex");
    check(
      "anchor-update arrives signed, verifiable against canonical JSON + machine secret",
      !!updCmd &&
        updCmd.type === "anchor-update" &&
        updCmd.payload?.stamp === SERVED_STAMP &&
        updCmd.signature === expectedUpdSig &&
        updCmd.signature === updQ.data.signature,
      JSON.stringify(updCmd)
    );
    // The deed the machine reports folds into the anchor ledger
    // and onto its record.
    r = await fetch(`${d}/api/headless/commands/${updQ.data.commandId}/result`, {
      method: "POST",
      headers: { ...AAUTH, "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          status: "updating",
          anchor: {
            action: "update",
            role: "host",
            fromStamp: "202601010000",
            toStamp: SERVED_STAMP,
            outcome: "updating",
            detail: "restarting onto the new build"
          }
        }
      })
    });
    check("anchor-update result posts", r.status === 200);
    r = await fetch(`${d}/mover/console/api/anchor-ledger`, {
      headers: { "x-console-key": CONSOLE_KEY }
    });
    const aLedger = await r.json();
    check(
      "anchor result folds into the anchor ledger with the full record shape",
      r.status === 200 &&
        aLedger.records?.length === 1 &&
        aLedger.records[0].machineId === AMID &&
        aLedger.records[0].accountId === ANCHOR_ACC &&
        aLedger.records[0].action === "update" &&
        aLedger.records[0].fromStamp === "202601010000" &&
        aLedger.records[0].toStamp === SERVED_STAMP &&
        aLedger.records[0].outcome === "updating" &&
        typeof aLedger.records[0].at === "string",
      JSON.stringify(aLedger).slice(0, 300)
    );
    // The new instance heartbeats its new stamp and the
    // concluded deed: both land on the machine record.
    r = await fetch(`${d}/api/headless/heartbeat`, {
      method: "POST",
      headers: { ...AAUTH, "content-type": "application/json" },
      body: JSON.stringify({
        state: "idle",
        buildStamp: SERVED_STAMP,
        anchor: {
          action: "update",
          role: "host",
          fromStamp: "202601010000",
          toStamp: SERVED_STAMP,
          outcome: "updated",
          detail: "The Host updated itself."
        }
      })
    });
    check("post-update heartbeat posts", r.status === 200);
    r = await fetch(
      `${d}/mover/console/api/machines?accountId=${ANCHOR_ACC}`,
      { headers: { "x-console-key": CONSOLE_KEY } }
    );
    const dMachines2 = await r.json();
    const dRow2 = (dMachines2.machines ?? []).find(
      (m) => m.machineId === AMID
    );
    check(
      "machine record shows the new stamp and the concluded deed",
      dRow2?.buildStamp === SERVED_STAMP &&
        dRow2?.anchorLast?.outcome === "updated" &&
        dRow2?.anchorLast?.toStamp === SERVED_STAMP,
      JSON.stringify(dRow2 ?? {}).slice(0, 300)
    );
    // A deliver queues signed too, naming the sibling role.
    const delQ = await queueAnchor("anchor-deliver", {
      role: "viewer",
      stamp: SERVED_STAMP
    });
    check(
      "console anchor-deliver queues a signed command",
      delQ.status === 200 &&
        /^[0-9a-f]{64}$/.test(delQ.data.signature ?? ""),
      JSON.stringify(delQ.data)
    );
    // License gate: revoking the admin product blocks host
    // build downloads for the account; the mover product's
    // builds still flow; restoring reopens the door.
    const licD = async (action, product) => {
      const res = await fetch(`${d}/mover/console/api/licenses/${action}`, {
        method: "POST",
        headers: KH,
        body: JSON.stringify({ product, accountId: ANCHOR_ACC })
      });
      return res.status;
    };
    check(
      "anchor test account admin license revoked (gate setup)",
      (await licD("revoke", "admin")) === 200
    );
    r = await fetch(`${d}/api/headless/build?role=host`, { headers: AAUTH });
    const revokedBody = await r.json().catch(() => ({}));
    check(
      "host build download for a revoked account -> 403 LICENSE_REVOKED",
      r.status === 403 && revokedBody.error === "LICENSE_REVOKED",
      `got ${r.status} ${JSON.stringify(revokedBody)}`
    );
    r = await fetch(`${d}/api/headless/build?role=mover`, { headers: AAUTH });
    check(
      "mover build download still flows (only the admin product is revoked)",
      r.status === 200,
      `got ${r.status}`
    );
    check(
      "anchor test account admin license restored",
      (await licD("restore", "admin")) === 200
    );
    r = await fetch(`${d}/api/headless/build?role=host`, { headers: AAUTH });
    check(
      "host build download works again after the restore",
      r.status === 200,
      `got ${r.status}`
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

    // ---------------------------------------------------------------
    // Instance P: THE PARTITION routes (status, rebuild, browse,
    // document, wallpaper, desktop-icons, pins, mutate, ledger).
    // Fresh data dir so the sealed-move view is fully known here.
    // Instance PE then boots on the same data dir to prove the
    // Delete/Rename ledger is read back from disk.
    // ---------------------------------------------------------------
    console.log("partition routes");
    const PD = 4422;
    const dataDirD = `${dataDir}-partition`;
    children.push(boot(PD, { MOVER_DATA_DIR: dataDirD }));
    check("instance P (partition) boots", await waitHealth(PD));
    const pd = `http://127.0.0.1:${PD}`;
    const P_ACC = "partacct000001";
    const Q_ACC = "partacct000002";
    const P_MID = "owner-pc-173";
    const P_NAME = "OWNER-173";
    const PH = { "x-account-id": P_ACC, "content-type": "application/json" };
    const QH = { "x-account-id": Q_ACC, "content-type": "application/json" };
    const pget = (acc, mid, sub) =>
      fetch(`${pd}/api/partition/${mid}/${sub}`, {
        headers: { "x-account-id": acc }
      });
    const ppost = (acc, mid, sub, body) =>
      fetch(`${pd}/api/partition/${mid}/${sub}`, {
        method: "POST",
        headers: { "x-account-id": acc, "content-type": "application/json" },
        body: JSON.stringify(body ?? {})
      });
    const announceMove = (headers, moverName, m) =>
      fetch(`${pd}/api/moves`, {
        method: "POST",
        headers,
        body: JSON.stringify({ moverName, manifest: m })
      });
    const pf = (p, size, modTime, sha) => ({
      path: p,
      category: p.split("/")[0],
      size,
      modTime,
      sha256: sha,
      chunks: 1
    });

    r = await fetch(`${pd}/api/headless/enroll`, {
      method: "POST",
      headers: PH,
      body: JSON.stringify({
        machineId: P_MID,
        name: P_NAME,
        os: "Windows 11 Pro",
        profiles: ["OWNER"],
        capabilities: { desktop: true }
      })
    });
    const pEnrolled = await r.json().catch(() => ({}));
    check(
      "partition: source machine enrolled (name hint for binding)",
      r.status === 200 && /^[0-9a-f]{64}$/.test(pEnrolled.machineSecret ?? ""),
      `got ${r.status}`
    );

    // Move 1: bound by the enrolled NAME (sourceName == machine name).
    const PMOVE1 = "move-2026102801-0001";
    const TASKBAR =
      "appData/Roaming/Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar";
    const STARTP = "appData/Roaming/Microsoft/Windows/Start Menu/Programs";
    r = await announceMove(PH, P_NAME, {
      moveId: PMOVE1,
      name: "Owner PC pull 1",
      sourceName: P_NAME,
      files: [
        pf("files/Desktop/Report.docx", 100, 1000, "sha-report"),
        pf("files/Desktop/Email Sorter.lnk", 2, 1000, "sha-eslnk"),
        pf("files/Desktop/Projects/plan.txt", 7, 1000, "sha-plan"),
        pf("files/Documents/notes.txt", 11, 1000, "sha-notes-old"),
        pf("files/Documents/Sub/deep.txt", 3, 1000, "sha-deep"),
        pf("files/../escape.txt", 1, 1000, "sha-escape"),
        pf("setup/wallpaper/img0.jpg", 50, 500, "sha-wp0"),
        pf("setup/wallpaper/img1.jpg", 60, 900, "sha-wp1"),
        pf(`${TASKBAR}/Chrome.lnk`, 4, 1000, "sha-chrome"),
        pf(`${STARTP}/Email Sorter Ultimate.lnk`, 4, 1000, "sha-esu")
      ],
      chunks: [],
      totalBytes: 242,
      totalFiles: 10
    });
    check("partition: move 1 announced", r.status === 200, `got ${r.status}`);
    // createdAt is second-resolution; the view's "later move wins"
    // rule needs move 2 to be strictly later.
    await new Promise((res) => setTimeout(res, 1200));
    // Move 2: bound by machineId (case-insensitive), fresher notes.txt.
    const PMOVE2 = "move-2026102802-0002";
    r = await announceMove(PH, "", {
      moveId: PMOVE2,
      name: "Owner PC pull 2",
      sourceName: P_MID.toUpperCase(),
      files: [pf("files/Documents/notes.txt", 222, 2000, "sha-notes-new")],
      chunks: [],
      totalBytes: 222,
      totalFiles: 1
    });
    check("partition: move 2 announced", r.status === 200, `got ${r.status}`);
    // Move 3: another machine on the same account (must stay unbound).
    const PMOVE3 = "move-2026102803-0003";
    r = await announceMove(PH, "OTHER-PC", {
      moveId: PMOVE3,
      sourceName: "OTHER-PC",
      files: [pf("files/Desktop/other.txt", 1, 1, "sha-other")],
      chunks: [],
      totalBytes: 1,
      totalFiles: 1
    });
    check("partition: move 3 (other machine) announced", r.status === 200);
    // Account Q holds a move claiming the SAME machine id.
    const QMOVE = "move-2026102804-0004";
    r = await announceMove(QH, P_MID, {
      moveId: QMOVE,
      sourceName: P_MID,
      files: [pf("files/Desktop/q-secret.txt", 9, 1, "sha-q")],
      chunks: [],
      totalBytes: 9,
      totalFiles: 1
    });
    check("partition: account Q move announced", r.status === 200);

    // ---- auth --------------------------------------------------------
    r = await fetch(`${pd}/api/partition/${P_MID}/status`);
    check("partition status without account -> 401", r.status === 401, `got ${r.status}`);
    r = await pget("bad!", P_MID, "status");
    check("partition status invalid account -> 401", r.status === 401, `got ${r.status}`);
    r = await fetch(`${pd}/api/partition/${P_MID}/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "delete", path: "files/Desktop/Report.docx", confirmed: true })
    });
    check("partition mutate without account -> 401", r.status === 401, `got ${r.status}`);

    // ---- rebuild -----------------------------------------------------
    r = await ppost(P_ACC, P_MID, "rebuild");
    const rebuilt = await r.json().catch(() => ({}));
    check(
      "partition rebuild binds by name + machineId, skips other machine",
      r.status === 200 &&
        rebuilt.machineId === P_MID &&
        Array.isArray(rebuilt.moveIds) &&
        rebuilt.moveIds.length === 2 &&
        rebuilt.moveIds.includes(PMOVE1) &&
        rebuilt.moveIds.includes(PMOVE2) &&
        !rebuilt.moveIds.includes(PMOVE3) &&
        !rebuilt.moveIds.includes(QMOVE),
      JSON.stringify(rebuilt)
    );
    check(
      "partition rebuild fileCount = 9 (.. path dropped, later move wins)",
      rebuilt.fileCount === 9,
      `got ${rebuilt.fileCount}`
    );
    check(
      "partition rebuild names the unbound move as a gap",
      Array.isArray(rebuilt.gaps) &&
        rebuilt.gaps.some((g) => g.startsWith("1 sealed move(s)") && g.includes(P_MID)) &&
        rebuilt.gaps.some((g) => g.includes("ciphertext")),
      JSON.stringify(rebuilt.gaps)
    );
    check(
      "partition rebuild updatedAt is RFC3339",
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(rebuilt.updatedAt || "")
    );

    // ---- status ------------------------------------------------------
    r = await pget(P_ACC, P_MID, "status");
    const pst = await r.json().catch(() => ({}));
    check(
      "partition status = rebuild view (9 files, 2 moves)",
      r.status === 200 &&
        pst.machineId === P_MID &&
        pst.fileCount === 9 &&
        pst.moveIds?.length === 2 &&
        Array.isArray(pst.gaps),
      JSON.stringify(pst)
    );
    r = await pget(P_ACC, "never-seen-pc", "status");
    const pstEmpty = await r.json().catch(() => ({}));
    check(
      "partition status for a machine with no bound moves -> empty view",
      r.status === 200 && pstEmpty.fileCount === 0 && pstEmpty.moveIds?.length === 0,
      JSON.stringify(pstEmpty)
    );
    r = await ppost(P_ACC, "never-seen-pc", "rebuild");
    const rbEmpty = await r.json().catch(() => ({}));
    check(
      "partition rebuild with no bound moves names that gap",
      r.status === 200 &&
        rbEmpty.fileCount === 0 &&
        rbEmpty.gaps?.some((g) => g.startsWith("No sealed moves bound")),
      JSON.stringify(rbEmpty.gaps)
    );

    // ---- browse ------------------------------------------------------
    r = await pget(P_ACC, P_MID, "browse");
    const broot = await r.json().catch(() => ({}));
    check(
      "partition browse root lists top-level categories as dirs, sorted",
      r.status === 200 &&
        broot.prefix === "" &&
        broot.total === 3 &&
        broot.children.map((c) => c.name).join(",") === "appData,files,setup" &&
        broot.children.every((c) => c.kind === "dir"),
      JSON.stringify(broot)
    );
    r = await pget(P_ACC, P_MID, "browse?prefix=/files/Documents/");
    const bdocs = await r.json().catch(() => ({}));
    const notesRef = bdocs.children?.find((c) => c.name === "notes.txt");
    check(
      "partition browse folder: dirs first, then files (slashes trimmed)",
      r.status === 200 &&
        bdocs.prefix === "files/Documents" &&
        bdocs.children.map((c) => c.kind + ":" + c.name).join(",") ===
          "dir:Sub,file:notes.txt",
      JSON.stringify(bdocs)
    );
    check(
      "partition browse: later sealed move wins on the same path",
      notesRef?.moveId === PMOVE2 && notesRef?.size === 222 && notesRef?.modTime === 2000,
      JSON.stringify(notesRef)
    );
    r = await pget(P_ACC, P_MID, "browse?prefix=files/Desktop&offset=1&limit=1");
    const bpage = await r.json().catch(() => ({}));
    check(
      "partition browse offset/limit pages, total stays whole",
      r.status === 200 &&
        bpage.total === 3 &&
        bpage.children.length === 1 &&
        bpage.children[0].name === "Email Sorter.lnk",
      JSON.stringify(bpage)
    );
    r = await pget(P_ACC, P_MID, "browse?prefix=files");
    const bfiles = await r.json().catch(() => ({}));
    check(
      "partition browse never surfaces a .. pack path",
      r.status === 200 &&
        !JSON.stringify(bfiles).includes("escape.txt") &&
        bfiles.children.map((c) => c.name).join(",") === "Desktop,Documents",
      JSON.stringify(bfiles)
    );
    r = await pget(Q_ACC, P_MID, "browse?prefix=files/Desktop");
    const bq = await r.json().catch(() => ({}));
    check(
      "partition browse is account-scoped (Q sees only Q's move)",
      r.status === 200 &&
        bq.children.map((c) => c.name).join(",") === "q-secret.txt",
      JSON.stringify(bq)
    );
    r = await pget(P_ACC, P_MID, "browse?prefix=files/Desktop");
    check(
      "partition browse: P never sees Q's file",
      !JSON.stringify(await r.json()).includes("q-secret")
    );

    // ---- document ----------------------------------------------------
    r = await pget(P_ACC, P_MID, "document?path=" + encodeURIComponent("files/Desktop/Report.docx"));
    const pdoc = await r.json().catch(() => ({}));
    check(
      "partition document returns refs only (no bytes)",
      r.status === 200 &&
        Object.keys(pdoc).sort().join(",") ===
          "category,modTime,moveId,packPath,sha256,size" &&
        pdoc.packPath === "files/Desktop/Report.docx" &&
        pdoc.moveId === PMOVE1 &&
        pdoc.size === 100 &&
        pdoc.sha256 === "sha-report" &&
        pdoc.category === "files",
      JSON.stringify(pdoc)
    );
    r = await pget(P_ACC, P_MID, "document");
    check("partition document without path -> 400", r.status === 400, `got ${r.status}`);
    r = await pget(P_ACC, P_MID, "document?path=files/Desktop/nope.docx");
    check("partition document unknown path -> 404", r.status === 404, `got ${r.status}`);
    r = await pget(Q_ACC, P_MID, "document?path=" + encodeURIComponent("files/Desktop/Report.docx"));
    check("partition document from another account -> 404", r.status === 404, `got ${r.status}`);

    // ---- wallpaper ---------------------------------------------------
    r = await pget(P_ACC, P_MID, "wallpaper");
    const pwp = await r.json().catch(() => ({}));
    check(
      "partition wallpaper picks the newest setup/wallpaper file",
      r.status === 200 &&
        pwp.present === true &&
        pwp.packPath === "setup/wallpaper/img1.jpg" &&
        pwp.moveId === PMOVE1,
      JSON.stringify(pwp)
    );
    r = await pget(Q_ACC, P_MID, "wallpaper");
    const pwpNone = await r.json().catch(() => ({}));
    check(
      "partition wallpaper absent -> { present: false }",
      r.status === 200 && pwpNone.present === false && Object.keys(pwpNone).length === 1,
      JSON.stringify(pwpNone)
    );

    // ---- desktop-icons -----------------------------------------------
    r = await pget(P_ACC, P_MID, "desktop-icons");
    const picons = await r.json().catch(() => ({}));
    check(
      "partition desktop-icons = files/Desktop children (dirs first)",
      r.status === 200 &&
        picons.children.map((c) => c.kind + ":" + c.name).join(",") ===
          "dir:Projects,file:Email Sorter.lnk,file:Report.docx",
      JSON.stringify(picons)
    );
    r = await pget(P_ACC, "never-seen-pc", "desktop-icons");
    const piconsNone = await r.json().catch(() => ({}));
    check(
      "partition desktop-icons empty machine -> []",
      r.status === 200 && Array.isArray(piconsNone.children) && piconsNone.children.length === 0
    );

    // ---- pins --------------------------------------------------------
    r = await pget(P_ACC, P_MID, "pins");
    const ppins = await r.json().catch(() => ({}));
    check(
      "partition pins: TaskBar pin from AppData Quick Launch path",
      r.status === 200 &&
        ppins.taskbar.length === 1 &&
        ppins.taskbar[0].name === "Chrome.lnk" &&
        ppins.taskbar[0].path === `${TASKBAR}/Chrome.lnk`,
      JSON.stringify(ppins.taskbar)
    );
    check(
      "partition pins: Start Menu Programs entry found",
      ppins.startPrograms?.length === 1 &&
        ppins.startPrograms[0].name === "Email Sorter Ultimate.lnk",
      JSON.stringify(ppins.startPrograms)
    );
    check(
      "partition pins: start2.bin + installed-apps gaps named",
      ppins.notes?.some((n) => n.includes("start2.bin")) &&
        ppins.notes?.some((n) => n.includes("Installed-apps")) &&
        !ppins.notes?.some((n) => n.startsWith("No TaskBar pin")),
      JSON.stringify(ppins.notes)
    );
    r = await pget(P_ACC, "never-seen-pc", "pins");
    const ppinsNone = await r.json().catch(() => ({}));
    check(
      "partition pins empty machine -> empty lists + named notes",
      r.status === 200 &&
        ppinsNone.taskbar.length === 0 &&
        ppinsNone.startPrograms.length === 0 &&
        ppinsNone.notes.some((n) => n.startsWith("No TaskBar pin")) &&
        ppinsNone.notes.some((n) => n.startsWith("No Start Menu Programs")),
      JSON.stringify(ppinsNone)
    );

    // ---- mutate: refusals first (ledger must stay empty) --------------
    r = await ppost(P_ACC, P_MID, "mutate", { op: "delete", path: "files/Desktop/Report.docx" });
    let mBody = await r.json().catch(() => ({}));
    check(
      "partition mutate without confirmed -> 400 confirmed:true required",
      r.status === 400 && mBody.error === "confirmed:true required",
      `got ${r.status} ${JSON.stringify(mBody)}`
    );
    r = await ppost(P_ACC, P_MID, "mutate", {
      op: "delete",
      path: "files/Desktop/Report.docx",
      confirmed: "true"
    });
    check(
      "partition mutate confirmed:\"true\" (string) is NOT consent -> 400",
      r.status === 400,
      `got ${r.status}`
    );
    r = await ppost(P_ACC, P_MID, "mutate", {
      op: "rename",
      path: "files/Desktop/Report.docx",
      newName: "x.docx",
      confirmed: false
    });
    check("partition rename confirmed:false -> 400", r.status === 400, `got ${r.status}`);
    const refusedOps = [
      "move",
      "copy",
      "write",
      "create",
      "upload",
      "push",
      "fetch",
      "restore",
      "chmod",
      "DELETE",
      "Rename",
      ""
    ];
    const opResults = [];
    for (const op of refusedOps) {
      r = await ppost(P_ACC, P_MID, "mutate", {
        op,
        path: "files/Desktop/Report.docx",
        newName: "x.docx",
        confirmed: true
      });
      const b = await r.json().catch(() => ({}));
      opResults.push({ op, status: r.status, error: b.error });
    }
    for (const res of opResults) {
      check(
        `partition mutate op "${res.op}" refused -> 400 op must be delete or rename`,
        res.status === 400 && res.error === "op must be delete or rename",
        JSON.stringify(res)
      );
    }
    r = await ppost(P_ACC, P_MID, "mutate", { op: "delete", path: "files/../escape.txt", confirmed: true });
    check("partition mutate path with .. -> 400", r.status === 400, `got ${r.status}`);
    r = await ppost(P_ACC, P_MID, "mutate", { op: "delete", path: "", confirmed: true });
    check("partition mutate empty path -> 400", r.status === 400, `got ${r.status}`);
    r = await ppost(P_ACC, P_MID, "mutate", { op: "delete", path: "files/Desktop/nope.docx", confirmed: true });
    mBody = await r.json().catch(() => ({}));
    check(
      "partition mutate path not in view -> 404",
      r.status === 404 && mBody.error === "path not in Partition view",
      `got ${r.status}`
    );
    for (const bad of ["", "a/b.docx", "..", "a\\b.docx"]) {
      r = await ppost(P_ACC, P_MID, "mutate", {
        op: "rename",
        path: "files/Desktop/Report.docx",
        newName: bad,
        confirmed: true
      });
      check(
        `partition rename newName ${JSON.stringify(bad)} -> 400`,
        r.status === 400,
        `got ${r.status}`
      );
    }
    r = await ppost(Q_ACC, P_MID, "mutate", { op: "delete", path: "files/Desktop/Report.docx", confirmed: true });
    check("partition mutate on another account's file -> 404", r.status === 404, `got ${r.status}`);
    r = await pget(P_ACC, P_MID, "ledger");
    let pled = await r.json().catch(() => ({}));
    check(
      "partition ledger empty after every refused mutate",
      r.status === 200 && Array.isArray(pled.records) && pled.records.length === 0,
      JSON.stringify(pled)
    );

    // ---- mutate: confirmed delete + rename --------------------------
    r = await ppost(P_ACC, P_MID, "mutate", {
      op: "delete",
      path: "/files/Desktop/Report.docx/",
      confirmed: true
    });
    const delRec = await r.json().catch(() => ({}));
    check(
      "partition confirmed delete -> ledger record",
      r.status === 200 &&
        /^pm-[0-9a-f]{16}$/.test(delRec.id || "") &&
        delRec.op === "delete" &&
        delRec.path === "files/Desktop/Report.docx" &&
        delRec.accountId === P_ACC &&
        delRec.machineId === P_MID &&
        delRec.confirmed === true &&
        delRec.newName === undefined,
      JSON.stringify(delRec)
    );
    r = await pget(P_ACC, P_MID, "document?path=" + encodeURIComponent("files/Desktop/Report.docx"));
    check("partition deleted document -> 404", r.status === 404, `got ${r.status}`);
    r = await pget(P_ACC, P_MID, "desktop-icons");
    check(
      "partition desktop-icons drop the deleted file",
      !(await r.json()).children.some((c) => c.name === "Report.docx")
    );
    r = await pget(P_ACC, P_MID, "status");
    check("partition status fileCount 9 -> 8 after delete", (await r.json()).fileCount === 8);

    r = await ppost(P_ACC, P_MID, "mutate", {
      op: "rename",
      path: "files/Documents/notes.txt",
      newName: "  notes-renamed.txt ",
      confirmed: true
    });
    const renRec = await r.json().catch(() => ({}));
    check(
      "partition confirmed rename -> ledger record (newName trimmed)",
      r.status === 200 && renRec.op === "rename" && renRec.newName === "notes-renamed.txt",
      JSON.stringify(renRec)
    );
    r = await pget(P_ACC, P_MID, "browse?prefix=files/Documents");
    const bren = await r.json().catch(() => ({}));
    const renamedRef = bren.children?.find((c) => c.name === "notes-renamed.txt");
    check(
      "partition browse shows the renamed file with the same sealed ref",
      !bren.children?.some((c) => c.name === "notes.txt") &&
        renamedRef?.moveId === PMOVE2 &&
        renamedRef?.size === 222,
      JSON.stringify(bren)
    );
    r = await pget(P_ACC, P_MID, "document?path=" + encodeURIComponent("files/Documents/notes-renamed.txt"));
    const renDoc = await r.json().catch(() => ({}));
    check(
      "partition document resolves under the new name",
      r.status === 200 && renDoc.sha256 === "sha-notes-new" && renDoc.moveId === PMOVE2,
      JSON.stringify(renDoc)
    );

    // Folder delete drops its children.
    r = await ppost(P_ACC, P_MID, "mutate", { op: "delete", path: "files/Documents/Sub", confirmed: true });
    check("partition confirmed folder delete -> 200", r.status === 200, `got ${r.status}`);
    r = await pget(P_ACC, P_MID, "document?path=" + encodeURIComponent("files/Documents/Sub/deep.txt"));
    check("partition folder delete drops its children", r.status === 404, `got ${r.status}`);

    // Folder rename (the Explorer Rename button acts on the focused
    // item, which can be a folder): children move with it.
    r = await ppost(P_ACC, P_MID, "mutate", {
      op: "rename",
      path: "files/Desktop/Projects",
      newName: "Work",
      confirmed: true
    });
    check("partition confirmed folder rename -> 200", r.status === 200, `got ${r.status}`);
    r = await pget(P_ACC, P_MID, "desktop-icons");
    const iconsAfter = await r.json().catch(() => ({}));
    check(
      "partition folder rename shows the new folder name, old gone",
      iconsAfter.children?.some((c) => c.kind === "dir" && c.name === "Work") &&
        !iconsAfter.children?.some((c) => c.name === "Projects"),
      JSON.stringify(iconsAfter)
    );
    r = await pget(P_ACC, P_MID, "document?path=" + encodeURIComponent("files/Desktop/Work/plan.txt"));
    const movedChild = await r.json().catch(() => ({}));
    check(
      "partition folder rename carries children (same sealed ref)",
      r.status === 200 && movedChild.moveId === PMOVE1 && movedChild.sha256 === "sha-plan",
      `got ${r.status} ${JSON.stringify(movedChild)}`
    );

    // ---- ledger --------------------------------------------------------
    r = await pget(P_ACC, P_MID, "ledger");
    pled = await r.json().catch(() => ({}));
    check(
      "partition ledger lists confirmed delete/rename only, in order",
      r.status === 200 &&
        pled.records.map((x) => x.op).join(",") === "delete,rename,delete,rename" &&
        pled.records.every((x) => x.confirmed === true && x.accountId === P_ACC) &&
        pled.records[0].id === delRec.id,
      JSON.stringify(pled)
    );
    r = await pget(Q_ACC, P_MID, "ledger");
    check(
      "partition ledger is account-scoped (Q sees none of P's)",
      r.status === 200 && (await r.json()).records.length === 0
    );

    // ---- source stays read-only; view holds no bytes -----------------
    r = await fetch(`${pd}/api/moves/${PMOVE1}/manifest`, { headers: PH });
    const m1After = await r.json().catch(() => ({}));
    check(
      "partition mutate never touches the sealed move manifest",
      r.status === 200 &&
        m1After.files.some((f) => f.path === "files/Desktop/Report.docx") &&
        m1After.files.some((f) => f.path === "files/Desktop/Projects/plan.txt"),
      JSON.stringify(m1After.files?.map((f) => f.path))
    );
    r = await fetch(`${pd}/api/headless/commands`, {
      headers: {
        "x-account-id": P_ACC,
        "x-machine-id": P_MID,
        "x-machine-secret": pEnrolled.machineSecret
      }
    });
    const pCmds = await r.json().catch(() => null);
    check(
      "partition routes queued nothing for the source machine",
      r.status === 200 && Array.isArray(pCmds) && pCmds.length === 0,
      `got ${r.status} ${JSON.stringify(pCmds)}`
    );
        let partFiles = [];
    try {
      partFiles = readdirSync(path.join(dataDirD, P_ACC, "_partition", P_MID));
    } catch {
      partFiles = ["<missing>"];
    }
    // Catalog-first (doc 23): the partition dir now holds the standing
    // catalog.json (state-class listing source) BESIDE ledger.json. Both
    // are StateDocs JSON; neither is a bulk BYTE store. The guard still
    // forbids any second byte store -- anything other than these two.
    check(
      "partition disk holds only state JSON (catalog + ledger, no byte store)",
      partFiles.slice().sort().join(",") === "catalog.json,ledger.json",
      JSON.stringify(partFiles)
    );

    // ---- owner bug 2026-10-28: refresh must merge every bound move --
    // The owner pulled 123.txt + Hostinger.txt, then lufixsender, and
    // the refresh showed only lufixsender. The view is a UNION of all
    // bound moves (newest wins per path); a rebuild must never drop
    // an older move's files. These pins name that exact shape.
    const R_MID = "merge-pc-173";
    const R_NAME = "MERGE-173";
    r = await fetch(`${pd}/api/headless/enroll`, {
      method: "POST",
      headers: PH,
      body: JSON.stringify({ machineId: R_MID, name: R_NAME, os: "Windows 11 Pro" })
    });
    check("partition merge: second machine enrolled", r.status === 200, `got ${r.status}`);
    const RMOVE_A = "move-merge-0001";
    r = await announceMove(PH, R_NAME, {
      moveId: RMOVE_A,
      name: "Merge pull A",
      sourceName: R_NAME,
      files: [
        pf("files/Desktop/123.txt", 10, 1000, "sha-123"),
        pf("files/Desktop/Hostinger.txt", 20, 1000, "sha-hostinger")
      ],
      chunks: [],
      totalBytes: 30,
      totalFiles: 2
    });
    check("partition merge: move A announced", r.status === 200, `got ${r.status}`);
    const RMOVE_B = "move-merge-0002";
    r = await announceMove(PH, R_NAME, {
      moveId: RMOVE_B,
      name: "Merge pull B",
      sourceName: R_MID,
      files: [pf("files/Desktop/lufixsenderv1.exe", 30, 2000, "sha-lufix")],
      chunks: [],
      totalBytes: 30,
      totalFiles: 1
    });
    check("partition merge: move B announced", r.status === 200, `got ${r.status}`);
    r = await ppost(P_ACC, R_MID, "rebuild");
    const rbuilt = await r.json().catch(() => ({}));
    check(
      "partition merge: rebuild unions both moves (3 files, 2 moves)",
      r.status === 200 &&
        rbuilt.fileCount === 3 &&
        rbuilt.moveIds?.length === 2 &&
        rbuilt.moveIds.includes(RMOVE_A) &&
        rbuilt.moveIds.includes(RMOVE_B),
      JSON.stringify(rbuilt)
    );
    r = await pget(P_ACC, R_MID, "desktop-icons");
    const ricons = await r.json().catch(() => ({}));
    check(
      "partition merge: desktop shows every pulled file together",
      r.status === 200 &&
        ricons.children?.map((c) => c.name).sort().join(",") ===
          "123.txt,Hostinger.txt,lufixsenderv1.exe",
      JSON.stringify(ricons)
    );
    // A second rebuild (the owner's refresh) must not drop older moves.
    r = await ppost(P_ACC, R_MID, "rebuild");
    const rbuilt2 = await r.json().catch(() => ({}));
    check(
      "partition merge: second rebuild keeps all three files",
      r.status === 200 && rbuilt2.fileCount === 3,
      JSON.stringify(rbuilt2)
    );
    r = await pget(P_ACC, R_MID, "desktop-icons");
    const ricons2 = await r.json().catch(() => ({}));
    check(
      "partition merge: icons unchanged after refresh",
      ricons2.children?.map((c) => c.name).sort().join(",") ===
        "123.txt,Hostinger.txt,lufixsenderv1.exe",
      JSON.stringify(ricons2)
    );
    // Same-path conflict: the newer move's version wins, shown once.
    const RMOVE_C = "move-merge-0003";
    r = await announceMove(PH, R_NAME, {
      moveId: RMOVE_C,
      name: "Merge pull C",
      sourceName: R_MID,
      files: [pf("files/Desktop/123.txt", 99, 3000, "sha-123-new")],
      chunks: [],
      totalBytes: 99,
      totalFiles: 1
    });
    check("partition merge: move C announced", r.status === 200, `got ${r.status}`);
    r = await ppost(P_ACC, R_MID, "rebuild");
    const rbuilt3 = await r.json().catch(() => ({}));
    check(
      "partition merge: conflict keeps fileCount at 3",
      r.status === 200 && rbuilt3.fileCount === 3,
      JSON.stringify(rbuilt3)
    );
    r = await pget(P_ACC, R_MID, "document?path=" + encodeURIComponent("files/Desktop/123.txt"));
    const rdoc = await r.json().catch(() => ({}));
    check(
      "partition merge: newer move wins the same path (once, C's ref)",
      r.status === 200 &&
        rdoc.moveId === RMOVE_C &&
        rdoc.size === 99 &&
        rdoc.sha256 === "sha-123-new",
      JSON.stringify(rdoc)
    );
    // Ledger on top of the merged view: delete hides, rename shows once.
    r = await ppost(P_ACC, R_MID, "mutate", {
      op: "delete",
      path: "files/Desktop/Hostinger.txt",
      confirmed: true
    });
    check("partition merge: delete Hostinger -> 200", r.status === 200, `got ${r.status}`);
    r = await pget(P_ACC, R_MID, "desktop-icons");
    const ricons3 = await r.json().catch(() => ({}));
    check(
      "partition merge: deleted file drops, other moves stay",
      ricons3.children?.map((c) => c.name).sort().join(",") ===
        "123.txt,lufixsenderv1.exe",
      JSON.stringify(ricons3)
    );
    r = await ppost(P_ACC, R_MID, "mutate", {
      op: "rename",
      path: "files/Desktop/lufixsenderv1.exe",
      newName: "lufixsender.exe",
      confirmed: true
    });
    check("partition merge: rename lufix -> 200", r.status === 200, `got ${r.status}`);
    r = await pget(P_ACC, R_MID, "desktop-icons");
    const ricons4 = await r.json().catch(() => ({}));
    check(
      "partition merge: renamed file shows under the new name only",
      ricons4.children?.map((c) => c.name).sort().join(",") ===
        "123.txt,lufixsender.exe",
      JSON.stringify(ricons4)
    );

    // ---- machineId hygiene --------------------------------------------
    // The ledger lives at <dataDir>/<account>/_partition/<machineId>/,
    // so a machineId carrying path segments must never reach the store:
    // it would read (or write) another account's Partition ledger.
    r = await ppost(Q_ACC, P_MID, "mutate", {
      op: "delete",
      path: "files/Desktop/q-secret.txt",
      confirmed: true
    });
    check("partition account Q confirmed delete -> 200", r.status === 200, `got ${r.status}`);
    const crossMid = encodeURIComponent(`../../${Q_ACC}/_partition/${P_MID}`);
    r = await pget(P_ACC, crossMid, "ledger");
    const crossBody = await r.text();
    check(
      "partition machineId with path segments -> 400 (no cross-account ledger read)",
      r.status === 400 && !crossBody.includes("q-secret"),
      `got ${r.status} ${crossBody.slice(0, 200)}`
    );
    r = await ppost(P_ACC, crossMid, "mutate", {
      op: "delete",
      path: "files/Desktop/q-secret.txt",
      confirmed: true
    });
    check("partition mutate with path-segment machineId -> 400", r.status === 400, `got ${r.status}`);
    r = await ppost(P_ACC, encodeURIComponent("..\\x"), "rebuild");
    check("partition machineId with backslash -> 400", r.status === 400, `got ${r.status}`);
    r = await pget(P_ACC, encodeURIComponent(".hidden"), "status");
    check("partition machineId not starting alphanumeric -> 400", r.status === 400, `got ${r.status}`);

    // ---- ledger persists across a restart ----------------------------
    const PE = 4423;
    children.push(boot(PE, { MOVER_DATA_DIR: dataDirD }));
    check("instance PE boots on P's data dir", await waitHealth(PE));
    r = await fetch(`http://127.0.0.1:${PE}/api/partition/${P_MID}/ledger`, {
      headers: { "x-account-id": P_ACC }
    });
    const pledE = await r.json().catch(() => ({}));
    check(
      "partition ledger read back from disk on a fresh process",
      r.status === 200 && pledE.records?.length === 4 && pledE.records[0].id === delRec.id,
      JSON.stringify(pledE)
    );
    // The headless registry is in memory, so after a restart the Host
    // re-enrolls before its enrolled NAME can bind moves again.
    r = await fetch(`http://127.0.0.1:${PE}/api/headless/enroll`, {
      method: "POST",
      headers: PH,
      body: JSON.stringify({ machineId: P_MID, name: P_NAME, os: "Windows 11 Pro" })
    });
    check("partition: Host re-enrolls on the fresh process", r.status === 200, `got ${r.status}`);
    r = await fetch(`http://127.0.0.1:${PE}/api/partition/${P_MID}/status`, {
      headers: { "x-account-id": P_ACC }
    });
    const pstE = await r.json().catch(() => ({}));
    check(
      "partition fresh process re-applies the ledger over sealed moves (9 - 2 deletes = 7)",
      r.status === 200 && pstE.fileCount === 7 && pstE.moveIds?.length === 2,
      JSON.stringify(pstE)
    );
    r = await fetch(
      `http://127.0.0.1:${PE}/api/partition/${P_MID}/document?path=` +
        encodeURIComponent("files/Desktop/Work/plan.txt"),
      { headers: { "x-account-id": P_ACC } }
    );
    check(
      "partition fresh process keeps the folder rename",
      r.status === 200,
      `got ${r.status}`
    );

    // ---------------------------------------------------------------
    // Instances R1/R2: THE DURABLE STORE. Everything the server
    // holds is written through to <MOVER_DATA_DIR>/state/ and
    // reloaded at boot. R1 writes one of each kind, is KILLED
    // (SIGKILL: no shutdown flush exists or is needed), and R2
    // boots on the same data dir and must read it all back: the
    // enrollment with its secret, a still-queued command, live
    // and spent shares, a backup, a move, a partition ledger
    // entry, and a license revocation that still gates enroll.
    // ---------------------------------------------------------------
    console.log("durable store across a restart");
    const R1 = 4424;
    const R2 = 4425;
    const dataDirR = `${dataDir}-durable`;
    const DUR_ACC = "duracct0000001";
    const DUR_MID = "dur-host-01";
    const DUR_NAME = "DUR-HOST";
    const DH = {
      "x-account-id": DUR_ACC,
      "content-type": "application/json"
    };
    const r1child = boot(R1, {
      MOVER_DATA_DIR: dataDirR,
      MOVER_CONSOLE_KEY: CONSOLE_KEY
    });
    children.push(r1child);
    check("durable instance R1 boots", await waitHealth(R1));
    const r1 = `http://127.0.0.1:${R1}`;

    // Shares: one spent on R1, one left live, one account share.
    const durBlob = {
      iv: randomBytes(12).toString("base64"),
      data: randomBytes(128).toString("base64")
    };
    const sharePost = (body) =>
      fetch(`${r1}/api/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    r = await sharePost({ blob: durBlob, cookieCount: 4, siteCount: 2 });
    const spentShare = (await r.json()).id;
    r = await fetch(`${r1}/api/share/${spentShare}`);
    check(
      "durable setup: anon share consumed on R1",
      r.status === 200,
      `got ${r.status}`
    );
    r = await sharePost({ blob: durBlob, cookieCount: 4, siteCount: 2 });
    const liveShare = (await r.json()).id;
    const durKey = randomBytes(32).toString("base64");
    r = await sharePost({
      blob: durBlob,
      cookieCount: 4,
      siteCount: 2,
      accountId: DUR_ACC,
      key: durKey
    });
    const durAcctShare = (await r.json()).id;
    check(
      "durable setup: live + account shares created on R1",
      !!liveShare && !!durAcctShare
    );

    // Backup.
    const bakBlob = {
      salt: randomBytes(16).toString("base64"),
      iv: randomBytes(12).toString("base64"),
      iterations: 100000,
      data: randomBytes(64).toString("base64")
    };
    r = await fetch(`${r1}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blob: bakBlob,
        siteDomain: "example.com",
        cookieCount: 3
      })
    });
    const bakDur = await r.json().catch(() => ({}));
    check(
      "durable setup: backup created on R1",
      r.status === 201 && !!bakDur.id,
      `got ${r.status} ${JSON.stringify(bakDur)}`
    );

    // Headless enrollment + heartbeat + a command left queued.
    r = await fetch(`${r1}/api/headless/enroll`, {
      method: "POST",
      headers: DH,
      body: JSON.stringify({
        machineId: DUR_MID,
        name: DUR_NAME,
        os: "Windows Server 2022"
      })
    });
    const durEnroll = await r.json().catch(() => ({}));
    check(
      "durable setup: machine enrolls on R1",
      r.status === 200 && /^[0-9a-f]{64}$/.test(durEnroll.machineSecret ?? ""),
      JSON.stringify(durEnroll)
    );
    const DUR_AUTH = {
      "x-account-id": DUR_ACC,
      "x-machine-id": DUR_MID,
      "x-machine-secret": durEnroll.machineSecret,
      "content-type": "application/json"
    };
    r = await fetch(`${r1}/api/headless/heartbeat`, {
      method: "POST",
      headers: DUR_AUTH,
      body: JSON.stringify({ state: "idle" })
    });
    check(
      "durable setup: heartbeat accepted on R1",
      r.status === 200,
      `got ${r.status}`
    );
    r = await fetch(`${r1}/api/headless/commands`, {
      method: "POST",
      headers: {
        "x-account-id": DUR_ACC,
        "x-machine-id": DUR_MID,
        "content-type": "application/json"
      },
      body: JSON.stringify({ type: "scan", payload: {} })
    });
    const durCmd = await r.json().catch(() => ({}));
    check(
      "durable setup: command queued on R1 (never polled)",
      r.status === 200 && !!durCmd.commandId,
      JSON.stringify(durCmd)
    );

    // A sealed move + a partition ledger entry bound to the machine.
    const durManifest = {
      moveId: "move-durable-1",
      name: "Durable test move",
      sourceName: DUR_NAME,
      createdAt: "2026-10-28T00:00:00Z",
      categories: { files: 1 },
      files: [
        {
          path: "files/Desktop/durable-note.txt",
          category: "files",
          size: 3,
          sha256: "x",
          chunks: 1
        }
      ],
      chunks: [
        {
          index: 0,
          path: "files/Desktop/durable-note.txt",
          offset: 0,
          size: 3,
          sha256: "x"
        }
      ],
      totalBytes: 3,
      totalFiles: 1
    };
    r = await fetch(`${r1}/api/moves`, {
      method: "POST",
      headers: DH,
      body: JSON.stringify({ moverName: DUR_NAME, manifest: durManifest })
    });
    check(
      "durable setup: move announced on R1",
      r.status === 200,
      `got ${r.status}`
    );
    r = await fetch(`${r1}/api/partition/${DUR_MID}/rebuild`, {
      method: "POST",
      headers: DH,
      body: JSON.stringify({})
    });
    check(
      "durable setup: partition rebuild binds the move",
      r.status === 200,
      `got ${r.status}`
    );
    r = await fetch(`${r1}/api/partition/${DUR_MID}/mutate`, {
      method: "POST",
      headers: DH,
      body: JSON.stringify({
        op: "delete",
        path: "files/Desktop/durable-note.txt",
        confirmed: true
      })
    });
    const durMut = await r.json().catch(() => ({}));
    check(
      "durable setup: partition delete ledgered on R1",
      r.status === 200 && /^pm-[0-9a-f]{16}$/.test(durMut.id ?? ""),
      `got ${r.status} ${JSON.stringify(durMut)}`
    );

    // Licenses: issue two products, revoke one of them.
    const licPost = (sub, body) =>
      fetch(`${r1}/mover/console/api/licenses${sub}`, {
        method: "POST",
        headers: KH,
        body: JSON.stringify(body)
      });
    r = await licPost("", {
      product: "mover",
      accountId: DUR_ACC,
      label: "Durable test"
    });
    check(
      "durable setup: mover license issued on R1",
      r.status === 200,
      `got ${r.status}`
    );
    r = await licPost("", { product: "ext", accountId: DUR_ACC });
    check(
      "durable setup: ext license issued on R1",
      r.status === 200,
      `got ${r.status}`
    );
    r = await licPost("/revoke", { product: "ext", accountId: DUR_ACC });
    check(
      "durable setup: ext license revoked on R1",
      r.status === 200,
      `got ${r.status}`
    );

    // Kill R1 outright: durability must not depend on a clean exit.
    killTree(r1child, "SIGKILL");
    await new Promise((res) => setTimeout(res, 800));
    check(
      "R1 is really gone after SIGKILL (no orphaned server on its port)",
      !(await fetch(`${r1}/health`).then(() => true, () => false))
    );

    children.push(
      boot(R2, {
        MOVER_DATA_DIR: dataDirR,
        MOVER_CONSOLE_KEY: CONSOLE_KEY
      })
    );
    check("durable instance R2 boots on R1's data dir", await waitHealth(R2));
    const r2 = `http://127.0.0.1:${R2}`;

    r = await fetch(`${r2}/api/share/${spentShare}`);
    check(
      "spent single-use share stays spent after a restart",
      r.status === 404,
      `got ${r.status}`
    );
    r = await fetch(`${r2}/api/share/${liveShare}`);
    const liveGot = await r.json().catch(() => ({}));
    check(
      "live anon share survives a restart and still downloads",
      r.status === 200 && liveGot.blob?.data === durBlob.data,
      `got ${r.status}`
    );
    r = await fetch(`${r2}/api/account/${DUR_ACC}/shares/${durAcctShare}`);
    const acctGot = await r.json().catch(() => ({}));
    check(
      "account share survives a restart (blob + key)",
      r.status === 200 &&
        acctGot.key === durKey &&
        acctGot.blob?.data === durBlob.data,
      `got ${r.status}`
    );
    r = await fetch(`${r2}/api/backups/${bakDur.id}`);
    const bakGot = await r.json().catch(() => ({}));
    check(
      "backup survives a restart (blob round trip)",
      r.status === 200 && bakGot.blob?.data === bakBlob.data,
      `got ${r.status}`
    );
    r = await fetch(`${r2}/api/headless/machines`, {
      headers: { "x-account-id": DUR_ACC }
    });
    const durMachines = await r.json().catch(() => ({}));
    check(
      "enrollment survives a restart",
      r.status === 200 &&
        (durMachines.machines ?? []).some((m) => m.machineId === DUR_MID),
      JSON.stringify(durMachines).slice(0, 200)
    );
    r = await fetch(`${r2}/api/headless/heartbeat`, {
      method: "POST",
      headers: DUR_AUTH,
      body: JSON.stringify({ state: "idle" })
    });
    check(
      "the R1 machine secret still verifies after a restart",
      r.status === 200,
      `got ${r.status}`
    );
    r = await fetch(`${r2}/api/headless/commands`, { headers: DUR_AUTH });
    const durPoll = await r.json().catch(() => ({}));
    check(
      "the queued command survives a restart and is delivered once",
      r.status === 200 &&
        Array.isArray(durPoll) &&
        durPoll.some((c) => c.id === durCmd.commandId && c.type === "scan"),
      JSON.stringify(durPoll).slice(0, 200)
    );
    r = await fetch(`${r2}/api/headless/commands`, { headers: DUR_AUTH });
    const durPoll2 = await r.json().catch(() => ({}));
    check(
      "the delivered command is not delivered twice",
      r.status === 200 && Array.isArray(durPoll2) && durPoll2.length === 0,
      JSON.stringify(durPoll2).slice(0, 200)
    );
    r = await fetch(`${r2}/api/moves`, {
      headers: { "x-account-id": DUR_ACC }
    });
    const durMoves = await r.json().catch(() => ({}));
    check(
      "move metadata survives a restart",
      r.status === 200 &&
        Array.isArray(durMoves) &&
        durMoves.some((m) => m.moveId === "move-durable-1"),
      JSON.stringify(durMoves).slice(0, 200)
    );
    r = await fetch(`${r2}/api/partition/${DUR_MID}/ledger`, {
      headers: { "x-account-id": DUR_ACC }
    });
    const durLedger = await r.json().catch(() => ({}));
    check(
      "partition ledger survives a restart",
      r.status === 200 &&
        (durLedger.records ?? []).some((rec) => rec.id === durMut.id),
      JSON.stringify(durLedger).slice(0, 200)
    );
    r = await fetch(`${r2}/mover/console/api/licenses`, { headers: KH });
    const durLic = await r.json().catch(() => ({}));
    const durFor = (p) =>
      (durLic.licenses ?? []).find(
        (l) => l.accountId === DUR_ACC && l.product === p
      );
    check(
      "licenses survive a restart (issued stays active, revoked stays revoked)",
      r.status === 200 &&
        durFor("mover")?.status === "active" &&
        durFor("ext")?.status === "revoked",
      JSON.stringify(durLic).slice(0, 300)
    );
    r = await fetch(`${r2}/api/headless/enroll`, {
      method: "POST",
      headers: DH,
      body: JSON.stringify({
        machineId: "dur-host-02",
        name: "DUR-HOST-2",
        os: "Windows"
      })
    });
    check(
      "the revoked account is still blocked from enrolling after a restart",
      r.status === 403,
      `got ${r.status}`
    );

    // ---------------------------------------------------------------
    // Instances S1..S5: THE R2 OBJECT STORE + THE 14-DAY BULK
    // WINDOW. An in-process stub implements the S3 subset the R2
    // backend uses (PUT/GET/DELETE/HEAD + ListObjectsV2 with
    // continuation tokens, page size 2 on purpose; SigV4 is NOT
    // verified by the stub) over an in-memory map, so the R2 path
    // is genuinely exercised with no credentials. S1 writes one of
    // each kind against the stub with a throwaway local data dir,
    // is KILLED, and S2 boots on the same bucket with a DIFFERENT
    // empty local dir and must read it all back: the data lives in
    // the bucket, not on the disk. Then the window pins: a bulk
    // unit idle 15 days dies in the boot sweep, a fresh unit and
    // every state doc survive the same sweep, a bulk read on day
    // 13 refreshes last-use so the unit survives day 15, and once
    // it is idle 15 days past that read it dies.
    // ---------------------------------------------------------------
    console.log("R2 object store + bulk window (stub S3)");
    const stubObjects = new Map(); // "<bucket>/<key>" -> Buffer
    const xmlEsc = (s) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const stub = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      const parts = u.pathname
        .split("/")
        .filter((p) => p !== "")
        .map((p) => decodeURIComponent(p));
      const bucket = parts[0] ?? "";
      const key = parts.slice(1).join("/");
      if (req.method === "GET" && u.searchParams.get("list-type") === "2") {
        const prefix = u.searchParams.get("prefix") ?? "";
        const token = u.searchParams.get("continuation-token");
        const all = [...stubObjects.keys()]
          .filter((k) => k.startsWith(`${bucket}/${prefix}`))
          .map((k) => k.slice(bucket.length + 1))
          .sort();
        const startAt = token ? Number(token) : 0;
        const page = all.slice(startAt, startAt + 2);
        const truncated = startAt + page.length < all.length;
        const contents = page
          .map(
            (k) =>
              `<Contents><Key>${xmlEsc(k)}</Key><Size>${stubObjects.get(`${bucket}/${k}`).length}</Size></Contents>`
          )
          .join("");
        const next = truncated
          ? `<NextContinuationToken>${startAt + page.length}</NextContinuationToken>`
          : "";
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEsc(bucket)}</Name><Prefix>${xmlEsc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`
        );
        return;
      }
      const mapKey = `${bucket}/${key}`;
      if (req.method === "PUT") {
        const chunksIn = [];
        req.on("data", (c) => chunksIn.push(c));
        req.on("end", () => {
          stubObjects.set(mapKey, Buffer.concat(chunksIn));
          res.writeHead(200);
          res.end();
        });
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const body = stubObjects.get(mapKey);
        if (!body) {
          res.writeHead(404, { "content-type": "application/xml" });
          res.end("<Error><Code>NoSuchKey</Code></Error>");
          return;
        }
        res.writeHead(200, { "content-length": body.length });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      if (req.method === "DELETE") {
        stubObjects.delete(mapKey);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(400);
      res.end();
    });
    await new Promise((res) => stub.listen(4490, "127.0.0.1", res));

    const R2_ENV = {
      R2_ACCOUNT_ID: "stubacct",
      R2_BUCKET: "stub-bucket",
      R2_ACCESS_KEY_ID: "stubkey",
      R2_SECRET_ACCESS_KEY: "stubsecret",
      R2_ENDPOINT: "http://127.0.0.1:4490",
      MOVER_CONSOLE_KEY: CONSOLE_KEY
    };
    const BU_KEY = "stub-bucket/state/bulk-use.json";
    const backdateBulkUse = (unit, msAgo) => {
      const doc = JSON.parse(stubObjects.get(BU_KEY).toString("utf8"));
      doc[unit] = Date.now() - msAgo;
      stubObjects.set(BU_KEY, Buffer.from(JSON.stringify(doc)));
    };
    const bulkUseOf = (unit) =>
      JSON.parse(stubObjects.get(BU_KEY).toString("utf8"))[unit];
    const dirTop = (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    };
    const DAY = 86400000;
    const S_ACC = "r2acct00000001";
    const S_MID = "r2-host-01";
    const SH = {
      "x-account-id": S_ACC,
      "content-type": "application/json"
    };
    const sManifest = (moveId, size) => ({
      moveId,
      name: "R2 test move",
      sourceName: "R2-HOST",
      createdAt: "2026-10-28T00:00:00Z",
      categories: { files: 1 },
      files: [
        {
          path: "files/Desktop/r2-note.bin",
          category: "files",
          size,
          sha256: "x",
          chunks: 1
        }
      ],
      chunks: [
        {
          index: 0,
          path: "files/Desktop/r2-note.bin",
          offset: 0,
          size,
          sha256: "x"
        }
      ],
      totalBytes: size,
      totalFiles: 1
    });

    // ---- S1: write one of each kind against the stub. ----
    const S1 = 4426;
    const s1child = boot(S1, {
      ...R2_ENV,
      MOVER_DATA_DIR: `${dataDir}-r2a`
    });
    children.push(s1child);
    check("R2 instance S1 boots on the stub backend", await waitHealth(S1));
    const s1 = `http://127.0.0.1:${S1}`;
    const sBlob = {
      iv: randomBytes(12).toString("base64"),
      data: randomBytes(128).toString("base64")
    };
    const sSharePost = (body) =>
      fetch(`${s1}/api/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    r = await sSharePost({ blob: sBlob, cookieCount: 4, siteCount: 2 });
    const sSpent = (await r.json()).id;
    r = await fetch(`${s1}/api/share/${sSpent}`);
    check("R2 setup: anon share consumed on S1", r.status === 200, `got ${r.status}`);
    const sKey = randomBytes(32).toString("base64");
    r = await sSharePost({
      blob: sBlob,
      cookieCount: 4,
      siteCount: 2,
      accountId: S_ACC,
      key: sKey
    });
    const sAcctShare = (await r.json()).id;
    check("R2 setup: account share created on S1", !!sAcctShare);
    const sBakBlob = {
      salt: randomBytes(16).toString("base64"),
      iv: randomBytes(12).toString("base64"),
      iterations: 100000,
      data: randomBytes(64).toString("base64")
    };
    r = await fetch(`${s1}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blob: sBakBlob,
        siteDomain: "example.com",
        cookieCount: 3
      })
    });
    const sBak = await r.json().catch(() => ({}));
    check(
      "R2 setup: backup created on S1",
      r.status === 201 && !!sBak.id,
      `got ${r.status}`
    );
    r = await fetch(`${s1}/api/headless/enroll`, {
      method: "POST",
      headers: SH,
      body: JSON.stringify({
        machineId: S_MID,
        name: "R2-HOST",
        os: "Windows Server 2022"
      })
    });
    const sEnroll = await r.json().catch(() => ({}));
    check(
      "R2 setup: machine enrolls on S1",
      r.status === 200 && /^[0-9a-f]{64}$/.test(sEnroll.machineSecret ?? ""),
      JSON.stringify(sEnroll)
    );
    const S_AUTH = {
      "x-account-id": S_ACC,
      "x-machine-id": S_MID,
      "x-machine-secret": sEnroll.machineSecret,
      "content-type": "application/json"
    };
    r = await fetch(`${s1}/api/headless/heartbeat`, {
      method: "POST",
      headers: S_AUTH,
      body: JSON.stringify({ state: "idle" })
    });
    check("R2 setup: heartbeat accepted on S1", r.status === 200, `got ${r.status}`);
    r = await fetch(`${s1}/api/headless/commands`, {
      method: "POST",
      headers: {
        "x-account-id": S_ACC,
        "x-machine-id": S_MID,
        "content-type": "application/json"
      },
      body: JSON.stringify({ type: "scan", payload: {} })
    });
    const sCmd = await r.json().catch(() => ({}));
    check(
      "R2 setup: command queued on S1 (never polled)",
      r.status === 200 && !!sCmd.commandId,
      JSON.stringify(sCmd)
    );
    const sChunk = randomBytes(4096);
    r = await fetch(`${s1}/api/moves`, {
      method: "POST",
      headers: SH,
      body: JSON.stringify({
        moverName: "R2-HOST",
        manifest: sManifest("move-r2-1", sChunk.length)
      })
    });
    check("R2 setup: move announced on S1", r.status === 200, `got ${r.status}`);
    r = await fetch(`${s1}/api/moves/move-r2-1/chunks/0`, {
      method: "PUT",
      headers: {
        "x-account-id": S_ACC,
        "content-type": "application/octet-stream"
      },
      body: sChunk
    });
    check("R2 setup: chunk uploaded on S1", r.status === 200, `got ${r.status}`);
    const sLicPost = (sub, body) =>
      fetch(`${s1}/mover/console/api/licenses${sub}`, {
        method: "POST",
        headers: KH,
        body: JSON.stringify(body)
      });
    r = await sLicPost("", { product: "mover", accountId: S_ACC });
    check("R2 setup: mover license issued on S1", r.status === 200, `got ${r.status}`);
    r = await sLicPost("", { product: "ext", accountId: S_ACC });
    check("R2 setup: ext license issued on S1", r.status === 200, `got ${r.status}`);
    r = await sLicPost("/revoke", { product: "ext", accountId: S_ACC });
    check("R2 setup: ext license revoked on S1", r.status === 200, `got ${r.status}`);
    check(
      "state docs live in the bucket, not on the local disk",
      stubObjects.has("stub-bucket/state/shares.json") &&
        stubObjects.has("stub-bucket/state/licenses.json") &&
        stubObjects.has("stub-bucket/state/headless-machines.json") &&
        stubObjects.has(
          `stub-bucket/${S_ACC}/move-r2-1/chunks/0`
        ) &&
        dirTop(`${dataDir}-r2a`).length === 0,
      [...stubObjects.keys()].join(",")
    );

    killTree(s1child, "SIGKILL");
    await new Promise((res) => setTimeout(res, 800));
    check(
      "S1 is really gone after SIGKILL",
      !(await fetch(`${s1}/health`).then(() => true, () => false))
    );

    // ---- S2: same bucket, DIFFERENT empty local dir. ----
    const S2 = 4427;
    children.push(boot(S2, { ...R2_ENV, MOVER_DATA_DIR: `${dataDir}-r2b` }));
    check("R2 instance S2 boots on the same bucket", await waitHealth(S2));
    const s2 = `http://127.0.0.1:${S2}`;
    r = await fetch(`${s2}/api/share/${sSpent}`);
    check(
      "R2: spent single-use share stays spent across instances",
      r.status === 404,
      `got ${r.status}`
    );
    r = await fetch(`${s2}/api/account/${S_ACC}/shares/${sAcctShare}`);
    const sAcctGot = await r.json().catch(() => ({}));
    check(
      "R2: account share survives (blob + key)",
      r.status === 200 &&
        sAcctGot.key === sKey &&
        sAcctGot.blob?.data === sBlob.data,
      `got ${r.status}`
    );
    r = await fetch(`${s2}/api/backups/${sBak.id}`);
    const sBakGot = await r.json().catch(() => ({}));
    check(
      "R2: backup survives (blob round trip)",
      r.status === 200 && sBakGot.blob?.data === sBakBlob.data,
      `got ${r.status}`
    );
    r = await fetch(`${s2}/api/headless/heartbeat`, {
      method: "POST",
      headers: S_AUTH,
      body: JSON.stringify({ state: "idle" })
    });
    check(
      "R2: the S1 machine secret still verifies on S2",
      r.status === 200,
      `got ${r.status}`
    );
    r = await fetch(`${s2}/api/headless/commands`, { headers: S_AUTH });
    const sPoll = await r.json().catch(() => ({}));
    check(
      "R2: the queued command is delivered once on S2",
      r.status === 200 &&
        Array.isArray(sPoll) &&
        sPoll.some((c) => c.id === sCmd.commandId && c.type === "scan"),
      JSON.stringify(sPoll).slice(0, 200)
    );
    r = await fetch(`${s2}/api/headless/commands`, { headers: S_AUTH });
    const sPoll2 = await r.json().catch(() => ({}));
    check(
      "R2: the delivered command is not delivered twice",
      r.status === 200 && Array.isArray(sPoll2) && sPoll2.length === 0,
      JSON.stringify(sPoll2).slice(0, 200)
    );
    r = await fetch(`${s2}/api/moves/move-r2-1/chunks/0`, {
      headers: { "x-account-id": S_ACC }
    });
    const sDown = Buffer.from(await r.arrayBuffer());
    check(
      "R2: chunk bytes are identical after the instance swap",
      r.status === 200 && sDown.equals(sChunk),
      `got ${r.status}`
    );
    r = await fetch(`${s2}/api/headless/enroll`, {
      method: "POST",
      headers: SH,
      body: JSON.stringify({
        machineId: "r2-host-02",
        name: "R2-HOST-2",
        os: "Windows"
      })
    });
    check(
      "R2: the revoked license still gates enroll on S2",
      r.status === 403,
      `got ${r.status}`
    );
    // A fresh bulk unit on S2: it must survive the S3 boot sweep.
    const sFreshChunk = randomBytes(1024);
    r = await fetch(`${s2}/api/moves`, {
      method: "POST",
      headers: SH,
      body: JSON.stringify({
        moverName: "R2-HOST",
        manifest: sManifest("move-r2-fresh", sFreshChunk.length)
      })
    });
    r = await fetch(`${s2}/api/moves/move-r2-fresh/chunks/0`, {
      method: "PUT",
      headers: {
        "x-account-id": S_ACC,
        "content-type": "application/octet-stream"
      },
      body: sFreshChunk
    });
    check(
      "R2 setup: fresh move chunk uploaded on S2",
      r.status === 200,
      `got ${r.status}`
    );
    // Age move-r2-1 to 15 idle days in the shared last-use index,
    // then stop S2 without any further move traffic (an in-memory
    // touch would rewrite the index).
    backdateBulkUse(`${S_ACC}/move-r2-1`, 15 * DAY);
    const s2child = children[children.length - 1];
    killTree(s2child, "SIGKILL");
    await new Promise((res) => setTimeout(res, 800));
    check(
      "S2 is really gone after SIGKILL",
      !(await fetch(`${s2}/health`).then(() => true, () => false))
    );

    // ---- S3: the boot sweep runs; then the read-refresh pin. ----
    const S3P = 4428;
    const s3child = boot(S3P, {
      ...R2_ENV,
      MOVER_DATA_DIR: `${dataDir}-r2c`
    });
    children.push(s3child);
    check("R2 instance S3 boots (boot sweep runs)", await waitHealth(S3P));
    const s3 = `http://127.0.0.1:${S3P}`;
    r = await fetch(`${s3}/api/moves/move-r2-1/chunks/0`, {
      headers: { "x-account-id": S_ACC }
    });
    const sweptChunk = r.status;
    r = await fetch(`${s3}/api/moves/move-r2-1/manifest`, {
      headers: { "x-account-id": S_ACC }
    });
    check(
      "window: bulk idle 15 days is deleted by the boot sweep",
      sweptChunk === 404 && r.status === 404,
      `chunk ${sweptChunk} manifest ${r.status}`
    );
    r = await fetch(`${s3}/api/moves/move-r2-fresh/chunks/0`, {
      headers: { "x-account-id": S_ACC }
    });
    const sFreshDown = Buffer.from(await r.arrayBuffer());
    check(
      "window: recently used bulk survives the same sweep",
      r.status === 200 && sFreshDown.equals(sFreshChunk),
      `got ${r.status}`
    );
    r = await fetch(`${s3}/api/account/${S_ACC}/shares/${sAcctShare}`);
    check(
      "window: state is never swept (account share + headless registry intact)",
      r.status === 200 &&
        stubObjects.has("stub-bucket/state/headless-machines.json") &&
        stubObjects.has("stub-bucket/state/licenses.json"),
      `got ${r.status}`
    );
    // Read-refresh: age a unit to day 13 in the index, restart so
    // the server loads that age, read the chunk, and the index
    // must move to now before the response returns.
    const sChunk3 = randomBytes(2048);
    r = await fetch(`${s3}/api/moves`, {
      method: "POST",
      headers: SH,
      body: JSON.stringify({
        moverName: "R2-HOST",
        manifest: sManifest("move-r2-3", sChunk3.length)
      })
    });
    r = await fetch(`${s3}/api/moves/move-r2-3/chunks/0`, {
      method: "PUT",
      headers: {
        "x-account-id": S_ACC,
        "content-type": "application/octet-stream"
      },
      body: sChunk3
    });
    backdateBulkUse(`${S_ACC}/move-r2-3`, 13 * DAY);
    killTree(s3child, "SIGKILL");
    await new Promise((res) => setTimeout(res, 800));
    check(
      "S3 is really gone after SIGKILL",
      !(await fetch(`${s3}/health`).then(() => true, () => false))
    );
    const S3B = 4430;
    const s3bchild = boot(S3B, {
      ...R2_ENV,
      MOVER_DATA_DIR: `${dataDir}-r2c2`
    });
    children.push(s3bchild);
    check(
      "R2 instance S3b boots (unit at day 13 survives the boot sweep)",
      await waitHealth(S3B)
    );
    const s3b = `http://127.0.0.1:${S3B}`;
    r = await fetch(`${s3b}/api/moves/move-r2-3/chunks/0`, {
      headers: { "x-account-id": S_ACC }
    });
    const refreshed = bulkUseOf(`${S_ACC}/move-r2-3`);
    check(
      "window: a bulk read refreshes last-use (day 13 read lands in the index)",
      r.status === 200 && Date.now() - refreshed < 60000,
      `index age ${Date.now() - refreshed}ms`
    );
    // Age the refreshed entry by only 2 more days: at the next
    // boot the unit is 15 days past its WRITE but 2 days past its
    // last READ, so it must survive.
    backdateBulkUse(`${S_ACC}/move-r2-3`, 2 * DAY);
    killTree(s3bchild, "SIGKILL");
    await new Promise((res) => setTimeout(res, 800));

    // ---- S4: day 15 from the write, day 2 from the read. ----
    const S4 = 4429;
    const s4child = boot(S4, {
      ...R2_ENV,
      MOVER_DATA_DIR: `${dataDir}-r2d`
    });
    children.push(s4child);
    check("R2 instance S4 boots", await waitHealth(S4));
    const s4 = `http://127.0.0.1:${S4}`;
    r = await fetch(`${s4}/api/moves/move-r2-3/chunks/0`, {
      headers: { "x-account-id": S_ACC }
    });
    const s3Down = Buffer.from(await r.arrayBuffer());
    check(
      "window: bulk read on day 13 survives day 15",
      r.status === 200 && s3Down.equals(sChunk3),
      `got ${r.status}`
    );
    backdateBulkUse(`${S_ACC}/move-r2-3`, 15 * DAY);
    killTree(s4child, "SIGKILL");
    await new Promise((res) => setTimeout(res, 800));
    check(
      "S4 is really gone after SIGKILL",
      !(await fetch(`${s4}/health`).then(() => true, () => false))
    );

    // ---- S5: 15 idle days past the last read: swept. ----
    children.push(boot(S4, { ...R2_ENV, MOVER_DATA_DIR: `${dataDir}-r2e` }));
    check("R2 instance S5 boots", await waitHealth(S4));
    r = await fetch(`${s4}/api/moves/move-r2-3/chunks/0`, {
      headers: { "x-account-id": S_ACC }
    });
    check(
      "window: bulk idle 15 days past its last read is swept",
      r.status === 404,
      `got ${r.status}`
    );
    stub.close();
  } finally {
    for (const child of children) killTree(child, "SIGTERM");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
