// =========================================================================
// RELAYN MOVER — online console (Fastify plugin, TypeScript)
// -------------------------------------------------------------------------
// A page on this server where the owner makes Mover pairs anytime,
// without touching the cloud himself:
//
//   GET  /mover/console                  the console page (HTML)
//   POST /mover/console/api/pairs        create a pair (fresh account ID)
//   GET  /mover/console/api/pairs        pairs created on this server
//   POST /mover/console/api/config       download a config.json for a role
//   POST /mover/console/api/package      download a ready build for a role:
//                                        ONE exe with the config inbuilt
//
// Gating: every console endpoint requires the console key
// (MOVER_CONSOLE_KEY env). The key travels in the X-Console-Key header
// or the ?key= query parameter. If MOVER_CONSOLE_KEY is not set, ALL
// console endpoints return 404 — the console does not exist. A wrong
// key also returns 404, for the same reason.
//
// INBUILT CONFIG (owner decision, supersedes the earlier zip shape):
// the ready build is a single exe with its config compiled in as an
// overlay appended after the executable image, in the Mover overlay
// format (one definition, mirrored from the Go apps'
// internal/config/overlay.go):
//
//   [ exe bytes ][ config JSON ][ uint32 LE json length ][ "RLNMCFG1" ]
//
// The exe's original bytes remain a strict prefix of the download —
// read from MOVER_BASE_EXE and never transformed; only bytes are
// appended. The app locates the overlay by scanning for the last
// occurrence of the magic, so when signing is unparked it is applied
// AFTER this merge (the Authenticode block then trails the overlay).
// When MOVER_BASE_EXE is unset the package download answers a clear
// 501 (config downloads keep working).
//
// The generated config.json is the full Mover config schema — the
// same shape the apps ship (defaults ported from the Go config) —
// with messages left at the apps' defaults.
// =========================================================================

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// -------------------------------------------------------------------------
// Defaults — ported from the Go apps' config (relayn-mover/internal/config).
// -------------------------------------------------------------------------

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const LANES = ["internet", "tailscale", "radmin", "lan", "drive"] as const;

export const MOVER_DEFAULT_MESSAGES: Record<string, string> = {
  appTitle: "Relayn Mover",
  loading: "Loading...",
  noFeatures: "This build has no features enabled in config.json.",
  errorPrefix: "Error: ",
  moverIntro:
    "This is the Mover build. Tick what moves, then tap the move button. Everything after that is automatic.",
  adminIntro:
    "This is the Admin build. Incoming moves from your linked Mover appear below on their own. Import is one tap.",
  inventoryTitle: "What is on this laptop",
  inventoryEmpty: "Nothing found to move.",
  totalLine: "Total: {count} items, {size}",
  selectAll: "Select all",
  clearAll: "Clear",
  selectedTotal: "Selected: {count} paths, {size}",
  etaLine: "About {eta} left (estimate, from your current upload speed)",
  startMove: "Start move",
  sending: "Sending",
  chunksWord: "chunks",
  moveSent: "Move sent. It is waiting in the Admin inbox on the new machine.",
  resumeLine: "Unfinished move {id}",
  resume: "Resume",
  inboxTitle: "Incoming moves",
  inboxEmpty:
    "No incoming moves yet. When your Mover sends one, it appears here on its own.",
  colMove: "Move",
  colFrom: "From",
  colSize: "Size",
  colFiles: "Files",
  colStatus: "Status",
  import: "Import",
  importParts: "Import parts...",
  report: "Report",
  importDone: "Import finished. Report:",
  continuityTitle: "Continuity: how this machine feels now",
  readyNow: "Ready now",
  needsAttention: "Needs your attention",
  partsPrompt:
    "Pack paths to import, comma separated (example: documents/report.pdf, pictures/cat.jpg). Leave a category out to import the rest later."
};

export interface MoverPairOptions {
  accountId: string;
  role: "mover" | "admin";
  serverUrl?: string;
  brand?: {
    name?: string;
    tagline?: string;
    bio?: string;
    primaryColor?: string;
    successBackground?: string;
    successColor?: string;
  };
  features?: { move?: boolean; inbox?: boolean; import?: boolean };
  categories?: {
    files?: boolean;
    appData?: boolean;
    setup?: boolean;
    browserPrep?: boolean;
  };
  customFolders?: string[];
  excludePatterns?: string[];
  selectAllByDefault?: boolean;
  transfer?: {
    profile?: string;
    laneOrder?: string[];
    chunkSizeMB?: number;
    parallelStreams?: number;
    ioBufferKB?: number;
    bandwidthLimitMbps?: number;
    retryCount?: number;
    retryBackoffMs?: number;
    chunkTimeoutSec?: number;
    chunkDelayMs?: number;
    preferDirect?: boolean;
  };
  admin?: {
    importDefault?: string;
    reinstallApps?: boolean;
    restoreAppData?: boolean;
    restoreSetup?: {
      git?: boolean;
      ssh?: boolean;
      fonts?: boolean;
      wallpaper?: boolean;
      wifi?: boolean;
    };
    verifyHashes?: boolean;
    keepPackAfterImport?: boolean;
  };
}

function boolOr(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function strOr(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * Build the complete config.json for one side of a pair. Defaults are
 * the apps' own defaults; role decides the feature set unless the
 * form overrides individual features.
 */
export function buildMoverConfig(opts: MoverPairOptions) {
  const role = opts.role === "admin" ? "admin" : "mover";
  const derivedFeatures =
    role === "admin"
      ? { move: false, inbox: true, import: true }
      : { move: true, inbox: false, import: false };
  const brand = opts.brand ?? {};
  const categories = opts.categories ?? {};
  const transfer = opts.transfer ?? {};
  const admin = opts.admin ?? {};
  const restoreSetup = admin.restoreSetup ?? {};

  return {
    account: { id: opts.accountId },
    role,
    server: {
      url: strOr(opts.serverUrl, "https://relayn-server.onrender.com").replace(
        /\/+$/,
        ""
      )
    },
    brand: {
      name: strOr(brand.name, "Relayn Mover"),
      tagline: strOr(brand.tagline, "Move this laptop, keep everything"),
      bio: strOr(
        brand.bio,
        "Moves your files, apps data and setup from an old laptop to a new one, encrypted and verified."
      ),
      primaryColor: strOr(brand.primaryColor, "#AC244D"),
      successBackground: strOr(brand.successBackground, "#e6f4ea"),
      successColor: strOr(brand.successColor, "#137333")
    },
    features: {
      move: boolOr(opts.features?.move, derivedFeatures.move),
      inbox: boolOr(opts.features?.inbox, derivedFeatures.inbox),
      import: boolOr(opts.features?.import, derivedFeatures.import)
    },
    mode: "fresh-import",
    mover: {
      selectAllByDefault: boolOr(opts.selectAllByDefault, true),
      categories: {
        files: boolOr(categories.files, true),
        appData: boolOr(categories.appData, true),
        setup: boolOr(categories.setup, true),
        browserPrep: boolOr(categories.browserPrep, true)
      },
      customFolders: Array.isArray(opts.customFolders)
        ? opts.customFolders.filter((f) => typeof f === "string")
        : [],
      excludePatterns: Array.isArray(opts.excludePatterns)
        ? opts.excludePatterns.filter((f) => typeof f === "string")
        : ["Temp", "Cache"],
      sourceRoot: "./source",
      browserProfileDir: ""
    },
    transfer: {
      profile: transfer.profile === "flash" ? "flash" : "standard",
      laneOrder:
        Array.isArray(transfer.laneOrder) && transfer.laneOrder.length > 0
          ? transfer.laneOrder.filter((l) =>
              (LANES as readonly string[]).includes(l)
            )
          : [...LANES],
      // Transfer defaults run at the highest values the apps and
      // this server accept (owner's max-by-default rule): chunk size
      // is capped by the server's per-chunk upload cap (64MB) below
      // the app's 512MB validation limit; streams and the I/O buffer
      // sit at the app's validated maxima. Three deliberate
      // exceptions, each flagged in the console form: retryCount 5
      // (retries are resilience, not speed; 20 with exponential
      // backoff would hide a dead chunk for a very long time),
      // retryBackoffMs 250 (an inverse field, higher means slower
      // recovery), chunkTimeoutSec 600 (the 3600 cap would let a
      // dead chunk hang for an hour, while the old 120 is too tight
      // for 64MB chunks on slow uplinks).
      chunkSizeMB: numOr(transfer.chunkSizeMB, 64),
      chunkSizeBytes: 0,
      resume: true,
      encryption: true,
      bandwidthLimitMbps: numOr(transfer.bandwidthLimitMbps, 0),
      parallelStreams: numOr(transfer.parallelStreams, 64),
      ioBufferKB: numOr(transfer.ioBufferKB, 65536),
      retryCount: numOr(transfer.retryCount, 5),
      retryBackoffMs: numOr(transfer.retryBackoffMs, 250),
      chunkTimeoutSec: numOr(transfer.chunkTimeoutSec, 600),
      chunkDelayMs: numOr(transfer.chunkDelayMs, 0),
      preferDirect: boolOr(transfer.preferDirect, false)
    },
    space: { policy: "warn-only" },
    admin: {
      importDefault: admin.importDefault === "parts" ? "parts" : "all",
      reinstallApps: boolOr(admin.reinstallApps, false),
      restoreAppData: boolOr(admin.restoreAppData, true),
      restoreSetup: {
        git: boolOr(restoreSetup.git, true),
        ssh: boolOr(restoreSetup.ssh, true),
        fonts: boolOr(restoreSetup.fonts, true),
        wallpaper: boolOr(restoreSetup.wallpaper, true),
        wifi: boolOr(restoreSetup.wifi, true)
      },
      verifyHashes: boolOr(admin.verifyHashes, true),
      keepPackAfterImport: boolOr(admin.keepPackAfterImport, true),
      destinationRoot: "./destination"
    },
    limits: { maxFileSizeMB: 0, maxPackSizeMB: 0 },
    report: { format: "both", includeHashes: true },
    app: {
      httpAddr: "127.0.0.1:8770",
      peerAddr: "127.0.0.1:8771",
      dataDir: "./mover-data",
      machineName: "",
      presenceSec: 10,
      uiPollMs: 700,
      requestTimeoutSec: 60
    },
    cloud: {
      addr: "127.0.0.1:8780",
      dataDir: "./cloud-data",
      retentionHours: 168,
      cleanupEveryMin: 60,
      maxChunkMB: 64
    },
    messages: { ...MOVER_DEFAULT_MESSAGES }
  };
}

/**
 * The same acceptance rules the apps apply to config.json (Go
 * validate()): a generated config must satisfy all of them as-is.
 */
export function validateMoverConfig(cfg: unknown): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const c = (cfg ?? {}) as Record<string, any>;
  if (!ACCOUNT_ID_RE.test(String(c.account?.id ?? ""))) {
    errors.push("account.id must be 8-64 URL-safe characters");
  }
  if (c.role !== "mover" && c.role !== "admin") {
    errors.push("role must be mover or admin");
  }
  let urlOk = false;
  try {
    const u = new URL(String(c.server?.url ?? ""));
    urlOk = (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    urlOk = false;
  }
  if (!urlOk) errors.push("server.url must be an http(s) URL with a host");
  if (c.mode !== "fresh-import") errors.push("mode must be fresh-import");
  if (c.space?.policy !== "warn-only") {
    errors.push("space.policy must be warn-only");
  }
  for (const key of ["primaryColor", "successBackground", "successColor"]) {
    if (!HEX_COLOR_RE.test(String(c.brand?.[key] ?? ""))) {
      errors.push(`brand.${key} must be a #RGB or #RRGGBB hex color`);
    }
  }
  for (const key of ["move", "inbox", "import"]) {
    if (typeof c.features?.[key] !== "boolean") {
      errors.push(`features.${key} must be boolean`);
    }
  }
  const lanes: unknown[] = c.transfer?.laneOrder ?? [];
  if (
    !Array.isArray(lanes) ||
    lanes.length === 0 ||
    lanes.some((l) => !(LANES as readonly string[]).includes(l as string))
  ) {
    errors.push("transfer.laneOrder must be a non-empty list of known lanes");
  }
  if (!c.messages || typeof c.messages !== "object") {
    errors.push("messages must be present (the apps' defaults)");
  }
  return { ok: errors.length === 0, errors };
}

// -------------------------------------------------------------------------
// Inbuilt config overlay (the Mover overlay format). The ready build
// is the base exe with the generated config appended:
//
//   [ exe bytes ][ config JSON ][ uint32 LE json length ][ magic ]
//
// The exe bytes are never transformed: they stay a strict prefix of
// the result. The apps' reader (Go internal/config/overlay.go) scans
// for the LAST occurrence of the magic, reads the length just before
// it, and parses the JSON just before that.
// -------------------------------------------------------------------------

export const OVERLAY_MAGIC = "RLNMCFG1";

export function buildInbuiltExe(exe: Buffer, cfgJson: Buffer): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(cfgJson.length, 0);
  return Buffer.concat([exe, cfgJson, lenBuf, Buffer.from(OVERLAY_MAGIC, "ascii")]);
}

// -------------------------------------------------------------------------
// Console page. One self-contained HTML file; the key rides in the URL
// the owner opens and in the X-Console-Key header for API calls.
// -------------------------------------------------------------------------

const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Relayn Mover Console</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 760px; padding: 0 1rem; color: #1a1a1a; }
  fieldset { border: 1px solid #ccc; border-radius: 8px; margin: 1rem 0; }
  legend { font-weight: 600; }
  label { display: block; margin: 0.4rem 0; }
  input[type=text], input[type=number], textarea, select { width: 100%; padding: 0.4rem; box-sizing: border-box; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; }
  .row > label { flex: 1; min-width: 160px; }
  .crow { display: flex; gap: 0.5rem; align-items: center; }
  .crow input[type=text] { flex: 1; }
  input[type=color] { width: 3rem; height: 2.1rem; padding: 0.1rem; border: 1px solid #ccc; border-radius: 6px; background: #fff; box-sizing: border-box; cursor: pointer; }
  button { padding: 0.6rem 1.2rem; border-radius: 8px; border: 0; background: #AC244D; color: #fff; cursor: pointer; font-size: 1rem; }
  button.ghost { background: #eee; color: #1a1a1a; }
  #status { white-space: pre-wrap; margin: 1rem 0; color: #7a102f; }
  code { background: #f3f3f3; padding: 0.1rem 0.3rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>Relayn Mover Console</h1>
<p>Make a Mover pair anytime. Create a pair, set the options, then download
the config or the ready build for each side. The two sides share one account
ID, that is what links them. The ready build is a single exe with the config
compiled in, nothing else to carry or place beside it.</p>
<div id="status"></div>

<fieldset>
  <legend>1. Pair</legend>
  <p>Account ID: <code id="accountId">(none yet)</code></p>
  <button id="createPair" type="button">Create a pair</button>
  <label>Or use an existing account ID
    <input type="text" id="accountIdInput" placeholder="8-64 URL-safe characters">
  </label>
</fieldset>

<fieldset>
  <legend>2. Options</legend>
  <label>Server URL
    <input type="text" id="serverUrl" value="https://relayn-server.onrender.com">
  </label>
  <div class="row">
    <label>Brand name <input type="text" id="brandName" value="Relayn Mover"></label>
    <label>Tagline <input type="text" id="brandTagline" value="Move this laptop, keep everything"></label>
  </div>
  <div class="row">
    <label>Primary colour
      <span class="crow"><input type="color" id="brandColorPick" value="#ac244d"><input type="text" id="brandColor" value="#AC244D"></span>
    </label>
    <label>Success background
      <span class="crow"><input type="color" id="brandSuccessBgPick" value="#e6f4ea"><input type="text" id="brandSuccessBg" value="#e6f4ea"></span>
    </label>
    <label>Success colour
      <span class="crow"><input type="color" id="brandSuccessPick" value="#137333"><input type="text" id="brandSuccess" value="#137333"></span>
    </label>
  </div>
  <label>Bio <input type="text" id="brandBio" value="Moves your files, apps data and setup from an old laptop to a new one, encrypted and verified."></label>

  <p><strong>What moves (Mover side)</strong></p>
  <label><input type="checkbox" id="catFiles" checked> Files</label>
  <label><input type="checkbox" id="catAppData" checked> App data</label>
  <label><input type="checkbox" id="catSetup" checked> Setup (fonts, wallpaper, WiFi, dev)</label>
  <label><input type="checkbox" id="catBrowser" checked> Browser state</label>
  <label><input type="checkbox" id="selectAll" checked> Select all by default</label>
  <label>Custom folders (one per line)
    <textarea id="customFolders" rows="2"></textarea>
  </label>

  <p><strong>Transfer</strong></p>
  <p>Every transfer setting below starts at the highest value the apps and this server accept, so a fresh pair runs at full speed. Step one down only for weak hardware or a very slow link.</p>
  <div class="row">
    <label>Profile
      <select id="profile">
        <option value="standard">standard</option>
        <option value="flash">flash (fastest the link allows)</option>
      </select>
    </label>
    <label>Lane order (comma separated)
      <input type="text" id="lanes" value="internet, tailscale, radmin, lan, drive">
    </label>
  </div>
  <div class="row">
    <label>Chunk size
      <select id="chunkMB">
        <option value="8">8 MB</option>
        <option value="16">16 MB</option>
        <option value="32">32 MB</option>
        <option value="64" selected>64 MB (max the server accepts)</option>
      </select>
    </label>
    <label>Parallel streams
      <select id="streams">
        <option value="4">4</option>
        <option value="8">8</option>
        <option value="16">16</option>
        <option value="32">32</option>
        <option value="64" selected>64 (max)</option>
      </select>
    </label>
  </div>
  <div class="row">
    <label>I/O buffer
      <select id="ioBufferKB">
        <option value="256">256 KB</option>
        <option value="1024">1 MB</option>
        <option value="4096">4 MB</option>
        <option value="16384">16 MB</option>
        <option value="65536" selected>64 MB (max)</option>
      </select>
    </label>
    <label>Bandwidth limit
      <select id="bandwidthMbps">
        <option value="0" selected>Unlimited (max)</option>
        <option value="100">100 Mbps</option>
        <option value="50">50 Mbps</option>
        <option value="25">25 Mbps</option>
        <option value="10">10 Mbps</option>
      </select>
    </label>
  </div>
  <div class="row">
    <label>Retries per chunk
      <select id="retryCount">
        <option value="1">1</option>
        <option value="3">3</option>
        <option value="5" selected>5</option>
        <option value="10">10</option>
        <option value="20">20</option>
      </select>
    </label>
    <label>Retry backoff (wait before each retry)
      <select id="retryBackoffMs">
        <option value="0">0 ms</option>
        <option value="100">100 ms</option>
        <option value="250" selected>250 ms</option>
        <option value="500">500 ms</option>
        <option value="1000">1 s</option>
        <option value="2000">2 s</option>
      </select>
    </label>
  </div>
  <div class="row">
    <label>Chunk timeout
      <select id="chunkTimeoutSec">
        <option value="60">1 min</option>
        <option value="120">2 min</option>
        <option value="300">5 min</option>
        <option value="600" selected>10 min</option>
        <option value="1800">30 min</option>
        <option value="3600">60 min</option>
      </select>
    </label>
    <label>Delay between chunks
      <select id="chunkDelayMs">
        <option value="0" selected>0 (full speed)</option>
        <option value="50">50 ms</option>
        <option value="100">100 ms</option>
        <option value="250">250 ms</option>
        <option value="500">500 ms</option>
      </select>
    </label>
  </div>
  <label><input type="checkbox" id="preferDirect"> Prefer direct lane when available</label>

  <p><strong>Admin restore</strong></p>
  <label>Import default
    <select id="importDefault">
      <option value="all">all</option>
      <option value="parts">parts</option>
    </select>
  </label>
  <label><input type="checkbox" id="restoreAppData" checked> Restore app data</label>
  <label><input type="checkbox" id="reinstallApps"> Reinstall apps (winget, where possible)</label>
  <label><input type="checkbox" id="verifyHashes" checked> Verify hashes after import</label>
  <label><input type="checkbox" id="keepPack" checked> Keep the pack after import</label>
  <label><input type="checkbox" id="rsGit" checked> Restore Git setup</label>
  <label><input type="checkbox" id="rsSsh" checked> Restore SSH keys</label>
  <label><input type="checkbox" id="rsFonts" checked> Restore fonts</label>
  <label><input type="checkbox" id="rsWallpaper" checked> Restore wallpaper</label>
  <label><input type="checkbox" id="rsWifi" checked> Restore WiFi profiles</label>
  <p>Space policy: <strong>warn-only</strong> (sizes are shown, space is your call, the move never blocks). Messages stay at the app defaults.</p>
</fieldset>

<fieldset>
  <legend>3. Download for a side</legend>
  <div class="row">
    <label>Side
      <select id="role">
        <option value="mover">Mover (old laptop)</option>
        <option value="admin">Admin (new machine)</option>
      </select>
    </label>
  </div>
  <p>
    <button id="dlConfig" type="button">Download config.json</button>
    <button id="dlExe" type="button" class="ghost">Download ready build (single exe, config inbuilt)</button>
  </p>
</fieldset>

<script>
  var key = new URLSearchParams(location.search).get("key") || "";
  var status = document.getElementById("status");
  function say(msg) { status.textContent = msg || ""; }
  // Colour fields: a native picker and a hex text box, kept in sync
  // both ways. The config reads the hex text box, exactly as before;
  // typing a valid 3 or 6 digit hex updates the picker (the picker
  // itself only holds 6 digit values, so a 3 digit hex is expanded
  // for the picker only, the text keeps what was typed).
  function wireColor(pickId, textId) {
    var pick = document.getElementById(pickId);
    var text = document.getElementById(textId);
    pick.addEventListener("input", function () { text.value = pick.value; });
    text.addEventListener("input", function () {
      var v = text.value.trim();
      if (/^#[0-9a-fA-F]{3}$/.test(v)) {
        pick.value = "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      } else if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        pick.value = v;
      }
    });
  }
  wireColor("brandColorPick", "brandColor");
  wireColor("brandSuccessBgPick", "brandSuccessBg");
  wireColor("brandSuccessPick", "brandSuccess");
  function accountId() {
    var typed = document.getElementById("accountIdInput").value.trim();
    return typed || document.getElementById("accountId").textContent;
  }
  function options() {
    return {
      accountId: accountId(),
      role: document.getElementById("role").value,
      serverUrl: document.getElementById("serverUrl").value,
      brand: {
        name: document.getElementById("brandName").value,
        tagline: document.getElementById("brandTagline").value,
        bio: document.getElementById("brandBio").value,
        primaryColor: document.getElementById("brandColor").value,
        successBackground: document.getElementById("brandSuccessBg").value,
        successColor: document.getElementById("brandSuccess").value
      },
      categories: {
        files: document.getElementById("catFiles").checked,
        appData: document.getElementById("catAppData").checked,
        setup: document.getElementById("catSetup").checked,
        browserPrep: document.getElementById("catBrowser").checked
      },
      customFolders: document.getElementById("customFolders").value.split("\\n").map(function (s) { return s.trim(); }).filter(Boolean),
      selectAllByDefault: document.getElementById("selectAll").checked,
      transfer: {
        profile: document.getElementById("profile").value,
        laneOrder: document.getElementById("lanes").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean),
        chunkSizeMB: Number(document.getElementById("chunkMB").value),
        parallelStreams: Number(document.getElementById("streams").value),
        ioBufferKB: Number(document.getElementById("ioBufferKB").value),
        bandwidthLimitMbps: Number(document.getElementById("bandwidthMbps").value),
        retryCount: Number(document.getElementById("retryCount").value),
        retryBackoffMs: Number(document.getElementById("retryBackoffMs").value),
        chunkTimeoutSec: Number(document.getElementById("chunkTimeoutSec").value),
        chunkDelayMs: Number(document.getElementById("chunkDelayMs").value),
        preferDirect: document.getElementById("preferDirect").checked
      },
      admin: {
        importDefault: document.getElementById("importDefault").value,
        reinstallApps: document.getElementById("reinstallApps").checked,
        restoreAppData: document.getElementById("restoreAppData").checked,
        verifyHashes: document.getElementById("verifyHashes").checked,
        keepPackAfterImport: document.getElementById("keepPack").checked,
        restoreSetup: {
          git: document.getElementById("rsGit").checked,
          ssh: document.getElementById("rsSsh").checked,
          fonts: document.getElementById("rsFonts").checked,
          wallpaper: document.getElementById("rsWallpaper").checked,
          wifi: document.getElementById("rsWifi").checked
        }
      }
    };
  }
  function api(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Console-Key": key },
      body: JSON.stringify(body || {})
    });
  }
  function saveBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  document.getElementById("createPair").addEventListener("click", async function () {
    say("");
    var res = await api("/mover/console/api/pairs");
    if (!res.ok) { say("Could not create a pair (HTTP " + res.status + ")."); return; }
    var data = await res.json();
    document.getElementById("accountId").textContent = data.accountId;
    document.getElementById("accountIdInput").value = "";
    say("Pair created. Download one side, then switch the side and download the other. Both carry this account ID.");
  });
  document.getElementById("dlConfig").addEventListener("click", async function () {
    say("");
    var opts = options();
    var res = await api("/mover/console/api/config", opts);
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      say("Config failed: " + (err.message || err.error || res.status));
      return;
    }
    saveBlob(await res.blob(), "config.json");
  });
  document.getElementById("dlExe").addEventListener("click", async function () {
    say("");
    var opts = options();
    var res = await api("/mover/console/api/package", opts);
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      say("Ready build failed: " + (err.message || err.error || res.status));
      return;
    }
    saveBlob(await res.blob(), opts.role === "admin" ? "relayn-mover-admin.exe" : "relayn-mover.exe");
  });
</script>
</body>
</html>`;

// -------------------------------------------------------------------------
// Plugin
// -------------------------------------------------------------------------

interface ConsolePair {
  accountId: string;
  createdAt: string;
}

export async function moverConsoleRoutes(
  app: FastifyInstance
): Promise<void> {
  const consoleKey = process.env.MOVER_CONSOLE_KEY ?? "";
  const pairs: ConsolePair[] = [];

  function gate(request: FastifyRequest, reply: FastifyReply): boolean {
    const provided =
      (request.headers["x-console-key"] as string | undefined) ??
      (request.query as { key?: string } | undefined)?.key ??
      "";
    if (!consoleKey || provided !== consoleKey) {
      reply.code(404).send({ error: "not found" });
      return false;
    }
    return true;
  }

  // The gate runs onRequest — before body parsing — so a missing or
  // wrong key (or an unset MOVER_CONSOLE_KEY) answers 404 for every
  // console endpoint no matter what the request body looks like.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/mover/console")) return;
    gate(request, reply);
  });

  function parseOptions(
    request: FastifyRequest,
    reply: FastifyReply
  ): MoverPairOptions | undefined {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const accountId = String(body.accountId ?? "");
    if (!ACCOUNT_ID_RE.test(accountId)) {
      reply.code(400).send({
        error: "INVALID_ACCOUNT",
        message: "accountId must be 8–64 URL-safe characters."
      });
      return undefined;
    }
    return {
      ...(body as unknown as MoverPairOptions),
      accountId,
      role: body.role === "admin" ? "admin" : "mover"
    };
  }

  app.get("/mover/console", async (request, reply) => {
    if (!gate(request, reply)) return;
    return reply.header("content-type", "text/html").send(CONSOLE_HTML);
  });

  app.post("/mover/console/api/pairs", async (request, reply) => {
    if (!gate(request, reply)) return;
    // Same shape as the accounts the apps already ship: mv + 20 hex.
    const pair: ConsolePair = {
      accountId: `mv${randomBytes(10).toString("hex")}`,
      createdAt: new Date().toISOString()
    };
    pairs.push(pair);
    return pair;
  });

  app.get("/mover/console/api/pairs", async (request, reply) => {
    if (!gate(request, reply)) return;
    return { pairs };
  });

  app.post("/mover/console/api/config", async (request, reply) => {
    if (!gate(request, reply)) return;
    const opts = parseOptions(request, reply);
    if (!opts) return;
    const cfg = buildMoverConfig(opts);
    const check = validateMoverConfig(cfg);
    if (!check.ok) {
      return reply.code(400).send({
        error: "INVALID_CONFIG",
        message: check.errors.join("; ")
      });
    }
    return reply
      .header("content-type", "application/json")
      .header("content-disposition", 'attachment; filename="config.json"')
      .send(JSON.stringify(cfg, null, 1));
  });

  app.post("/mover/console/api/package", async (request, reply) => {
    if (!gate(request, reply)) return;
    const opts = parseOptions(request, reply);
    if (!opts) return;

    const baseExe = process.env.MOVER_BASE_EXE ?? "";
    if (!baseExe) {
      return reply.code(501).send({
        error: "BASE_EXE_NOT_CONFIGURED",
        message:
          "MOVER_BASE_EXE is not set on this server, so ready builds are unavailable. The config.json download still works."
      });
    }
    let exe: Buffer;
    try {
      exe = await fs.readFile(baseExe);
    } catch {
      return reply.code(500).send({
        error: "BASE_EXE_UNREADABLE",
        message: "The base app file configured on this server could not be read."
      });
    }

    const cfg = buildMoverConfig(opts);
    const check = validateMoverConfig(cfg);
    if (!check.ok) {
      return reply.code(400).send({
        error: "INVALID_CONFIG",
        message: check.errors.join("; ")
      });
    }

    // One file out: the base exe with the config appended as an
    // inbuilt overlay. The exe bytes are a strict prefix of the
    // download, never transformed; the app reads the overlay from
    // its own tail at startup (sidecar config.json still wins if
    // the owner places one beside it later).
    const merged = buildInbuiltExe(
      exe,
      Buffer.from(JSON.stringify(cfg, null, 1), "utf8")
    );
    const filename =
      opts.role === "admin" ? "relayn-mover-admin.exe" : "relayn-mover.exe";
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .send(merged);
  });
}
