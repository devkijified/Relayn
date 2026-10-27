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
// Headless machines (the operator half of the headless track; the
// machine half is mover-headless.ts). Enrolled machines run with no
// signed-in user, so the operator verifies and starts moves here:
//
//   GET  /mover/console/api/machines                     enrolled machines
//   POST /mover/console/api/machines/:id/scan            queue a scan
//   POST /mover/console/api/machines/:id/browse          queue a browse
//   POST /mover/console/api/machines/:id/paths           queue a paths expansion
//   GET  /mover/console/api/machines/:id/result/:cmdId   a command's result
//   POST /mover/console/api/machines/:id/start           queue a SIGNED start
//
// The start payload carries concrete paths only: the console first
// expands the operator's ticked prefixes through "paths" commands,
// shows the exact totals in a confirmation step, and only then is
// the signed start queued. No confirmation render, no start — the
// zero-touch rule lives here, not on the machine.
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

import { isValidHeadlessMachineId, type MoverStore } from "./mover-store.js";

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
    headless: { enroll: true, pollSec: 5, serviceName: "RelaynMover" },
    // Background Admin defaults (the apps' own Desk defaults): the
    // private desktop a host build serves to an admin session.
    desk: {
      enabled: true,
      desktopName: "RelaynDesk",
      width: 1280,
      height: 800,
      jpegQuality: 70,
      maxDimension: 1600,
      frameFloorMs: 250,
      idleTtlSec: 900,
      launch: []
    },
    // View Screen defaults (the apps' own View defaults): the
    // view-only stream of the interactive desktop.
    view: {
      enabled: true,
      width: 1280,
      height: 720,
      jpegQuality: 70,
      maxDimension: 1600,
      frameFloorMs: 250,
      idleTtlSec: 900,
      simulateUser: "",
      simulateSessionFrames: 0
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
  .mrow { border: 1px solid #ddd; border-radius: 8px; padding: 0.6rem 0.8rem; margin: 0.5rem 0; }
  .mrow .meta { color: #555; font-size: 0.9rem; }
  .dot { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%; background: #bbb; margin-right: 0.4rem; }
  .dot.on { background: #137333; }
  .trow { margin: 0.2rem 0; }
  .trow .meta { color: #555; font-size: 0.9rem; margin-left: 0.4rem; }
  .kids { margin-left: 1.4rem; border-left: 1px dotted #ccc; padding-left: 0.6rem; }
  button.small { padding: 0.25rem 0.7rem; font-size: 0.9rem; }
  #confirmPanel { border: 2px solid #AC244D; border-radius: 8px; padding: 0.8rem; margin-top: 0.8rem; }
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

<fieldset>
  <legend>4. Machines (headless)</legend>
  <p>Machines that enrolled to run with <strong>no signed-in user</strong>. Load the
  machines for the account in section 1, scan one, browse what is on it, tick
  what moves, then start the move from here. The start command is signed for
  that machine and is queued only after a confirmation step shows the exact
  selection totals: no confirmation, no start.</p>
  <p>A machine with the background desktop capability also offers
  <strong>Open background desktop</strong>: a private desktop on that machine
  that the person sitting at it cannot see, touch, or end. Only the admin ends
  it, from the viewer page.</p>
  <p>A machine with someone signed in also offers <strong>View screen</strong>:
  a view-only watch of that person's real screen. Nothing on the view page
  can click, type or change anything on it; the view protocol has no input
  at all. Only the admin ends a view, from the viewer page.</p>
  <p><button id="loadMachines" type="button">Load machines for this account</button></p>
  <div id="machineList"></div>
  <div id="browsePanel" style="display:none">
    <h3 id="browseTitle"></h3>
    <div id="tree"></div>
    <p id="selTotal">Selected: 0 files, 0 B</p>
    <label>Move name <input type="text" id="moveName" value=""></label>
    <p>
      <button id="reviewStart" type="button">Review selection and start...</button>
      <button id="rescan" type="button" class="ghost">Rescan this machine</button>
    </p>
    <div id="confirmPanel" style="display:none">
      <p><strong>Confirm this move</strong></p>
      <p id="confirmText"></p>
      <p>
        <button id="confirmStart" type="button">Confirm and start move</button>
        <button id="cancelStart" type="button" class="ghost">Back</button>
      </p>
    </div>
  </div>
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

  // ---------------- Headless machines ----------------
  // Operator flow: load machines, scan one, browse its tree level by
  // level (scan, browse and paths are cloud commands the machine
  // answers on its next poll), tick a selection, review the exact
  // expanded totals, and only then queue the signed start.
  var hm = {
    machineId: "",
    machineName: "",
    agg: {},        // path -> {kind: "folder"|"file", count, bytes}
    inc: {},        // included prefixes: path -> true
    exc: {},        // excluded paths (carved out of an inclusion)
    rowBoxes: {},   // path -> [checkbox elements]
    pathsCache: {}  // prefix -> [concrete file paths]
  };
  var pendingStart = null; // {paths, count, bytes} awaiting confirmation

  function apiGet(path) {
    return fetch(path, { headers: { "X-Console-Key": key } });
  }
  function machineApi(machineId, action, body) {
    return api(
      "/mover/console/api/machines/" + encodeURIComponent(machineId) + "/" + action,
      body || {}
    );
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    var units = ["KB", "MB", "GB", "TB", "PB"];
    var v = n, i = -1;
    do { v = v / 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return (Math.round(v * 10) / 10) + " " + units[i];
  }
  async function pollResult(machineId, commandId) {
    for (var i = 0; i < 100; i++) {
      var res = await apiGet(
        "/mover/console/api/machines/" + encodeURIComponent(machineId) +
        "/result/" + encodeURIComponent(commandId) +
        "?accountId=" + encodeURIComponent(accountId())
      );
      if (res.ok) {
        var data = await res.json();
        if (data.status === "done") return data.result;
      }
      await new Promise(function (r) { setTimeout(r, 1200); });
    }
    throw new Error("Timed out waiting for the machine to answer.");
  }
  async function queueAndWait(machineId, action, body) {
    body = body || {};
    body.accountId = accountId();
    var res = await machineApi(machineId, action, body);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
    return pollResult(machineId, data.commandId);
  }

  // Selection rules, same include semantics as the app: ticking a
  // folder selects its whole subtree; unticking a row inside a
  // ticked folder carves out exactly that row.
  function isPrefixOf(prefix, path) {
    return path === prefix || path.indexOf(prefix + "/") === 0;
  }
  function ruleFor(path) {
    var best = null, bestLen = -1;
    Object.keys(hm.inc).forEach(function (p) {
      if (isPrefixOf(p, path) && p.length > bestLen) { bestLen = p.length; best = "inc"; }
    });
    Object.keys(hm.exc).forEach(function (p) {
      if (isPrefixOf(p, path) && p.length > bestLen) { bestLen = p.length; best = "exc"; }
    });
    return best; // "inc" | "exc" | null
  }
  function maximal(setObj) {
    var keys = Object.keys(setObj);
    return keys.filter(function (k) {
      return !keys.some(function (o) { return o !== k && isPrefixOf(o, k); });
    });
  }
  function selParts() {
    var incMax = maximal(hm.inc);
    var excMax = maximal(hm.exc);
    return {
      primary: incMax.filter(function (p) {
        return !excMax.some(function (e) { return isPrefixOf(e, p); });
      }),
      exc: excMax.filter(function (p) {
        return incMax.some(function (r) { return isPrefixOf(r, p); });
      }),
      reInc: incMax.filter(function (p) {
        return excMax.some(function (e) { return isPrefixOf(e, p); });
      })
    };
  }
  function aggOf(p) { return hm.agg[p] || { kind: "folder", count: 0, bytes: 0 }; }
  function selectedAggTotals() {
    var parts = selParts(), count = 0, bytes = 0;
    parts.primary.forEach(function (p) { var a = aggOf(p); count += a.count; bytes += a.bytes; });
    parts.exc.forEach(function (p) { var a = aggOf(p); count -= a.count; bytes -= a.bytes; });
    parts.reInc.forEach(function (p) { var a = aggOf(p); count += a.count; bytes += a.bytes; });
    return { count: count, bytes: bytes };
  }
  function renderSelTotal() {
    var t = selectedAggTotals();
    document.getElementById("selTotal").textContent =
      "Selected: " + t.count + " files, " + fmtBytes(t.bytes);
  }
  function setRule(path, want) {
    if (want) {
      delete hm.exc[path];
      hm.inc[path] = true;
    } else {
      delete hm.inc[path];
      Object.keys(hm.inc).forEach(function (p) {
        if (p !== path && isPrefixOf(path, p)) delete hm.inc[p];
      });
      var covered = Object.keys(hm.inc).some(function (p) {
        return p !== path && isPrefixOf(p, path);
      });
      if (covered) hm.exc[path] = true;
    }
    document.getElementById("confirmPanel").style.display = "none";
    pendingStart = null;
  }
  function refreshChecks() {
    Object.keys(hm.rowBoxes).forEach(function (path) {
      var rule = ruleFor(path);
      var incBelow = Object.keys(hm.inc).some(function (p) {
        return p !== path && isPrefixOf(path, p);
      });
      var excBelow = Object.keys(hm.exc).some(function (p) {
        return p !== path && isPrefixOf(path, p);
      });
      hm.rowBoxes[path].forEach(function (box) {
        box.checked = rule === "inc";
        box.indeterminate = rule === "inc" ? excBelow : incBelow;
      });
    });
  }

  function makeRow(child) {
    hm.agg[child.path] = child.kind === "folder"
      ? { kind: "folder", count: child.count || 0, bytes: child.bytes || 0 }
      : { kind: "file", count: 1, bytes: child.size || 0 };
    var wrap = document.createElement("div");
    var row = document.createElement("div");
    row.className = "trow";
    var box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", function () {
      setRule(child.path, box.checked);
      refreshChecks();
      renderSelTotal();
    });
    (hm.rowBoxes[child.path] = hm.rowBoxes[child.path] || []).push(box);
    row.appendChild(box);
    var kids = document.createElement("div");
    kids.className = "kids";
    kids.style.display = "none";
    if (child.kind === "folder") {
      var exp = document.createElement("button");
      exp.type = "button";
      exp.className = "ghost small";
      exp.textContent = "Open";
      exp.addEventListener("click", async function () {
        if (kids.style.display !== "none") { kids.style.display = "none"; exp.textContent = "Open"; return; }
        if (!kids.hasChildNodes()) {
          exp.textContent = "Loading...";
          try {
            await loadLevel(kids, child.path, 0);
          } catch (e) {
            say("Browse failed: " + e.message);
            exp.textContent = "Open";
            return;
          }
        }
        kids.style.display = "block";
        exp.textContent = "Close";
      });
      row.appendChild(exp);
    }
    var label = document.createElement("span");
    label.textContent = " " + child.name;
    row.appendChild(label);
    var meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = child.kind === "folder"
      ? "(" + (child.count || 0) + " files, " + fmtBytes(child.bytes || 0) + ")"
      : "(" + fmtBytes(child.size || 0) + ")";
    row.appendChild(meta);
    wrap.appendChild(row);
    wrap.appendChild(kids);
    return wrap;
  }
  async function loadLevel(kidsEl, prefix, offset) {
    var resp = await queueAndWait(hm.machineId, "browse", { prefix: prefix, offset: offset, limit: 200 });
    var children = (resp && resp.children) || [];
    children.forEach(function (ch) { kidsEl.appendChild(makeRow(ch)); });
    var shown = offset + children.length;
    if (resp && typeof resp.total === "number" && resp.total > shown) {
      var more = document.createElement("button");
      more.type = "button";
      more.className = "ghost small";
      more.textContent = "Show more (" + shown + " of " + resp.total + ")";
      more.addEventListener("click", async function () {
        more.remove();
        await loadLevel(kidsEl, prefix, shown);
      });
      kidsEl.appendChild(more);
    }
    refreshChecks();
  }

  async function scanMachine(machineId, machineName) {
    hm.machineId = machineId;
    hm.machineName = machineName;
    hm.agg = {}; hm.inc = {}; hm.exc = {}; hm.rowBoxes = {}; hm.pathsCache = {};
    pendingStart = null;
    document.getElementById("confirmPanel").style.display = "none";
    say("Scanning " + machineName + ". The machine answers on its next poll, this can take a few seconds.");
    try {
      var result = await queueAndWait(machineId, "scan", {});
      var summary = result && result.groups ? result : (result && result.summary) || null;
      if (!summary) { say("Scan finished, but the machine returned no inventory summary."); return; }
      var tree = document.getElementById("tree");
      while (tree.firstChild) tree.removeChild(tree.firstChild);
      (summary.groups || []).forEach(function (g) {
        tree.appendChild(makeRow({
          kind: g.file ? "file" : "folder",
          name: g.label || g.key,
          path: g.key,
          count: g.count || 0,
          bytes: g.bytes || 0,
          size: g.size || 0
        }));
      });
      document.getElementById("browseTitle").textContent = "Browsing " + machineName;
      document.getElementById("moveName").value = "Move from " + machineName;
      document.getElementById("browsePanel").style.display = "block";
      renderSelTotal();
      say("Scan complete: " + (summary.totalFiles || 0) + " files, " + fmtBytes(summary.totalBytes || 0) + " on " + machineName + ". Tick what moves.");
    } catch (e) {
      say("Scan failed: " + e.message);
    }
  }

  function progressText(m) {
    var bits = [];
    bits.push(m.online ? "online" : "offline, last seen " + m.lastSeen);
    bits.push("state: " + (m.state || "idle"));
    if (m.jobId) bits.push("job " + m.jobId);
    if (m.progress && typeof m.progress === "object") {
      if (typeof m.progress.percent === "number") bits.push(Math.round(m.progress.percent) + "%");
      if (m.progress.phase) bits.push(String(m.progress.phase));
    }
    var caps = m.capabilities && typeof m.capabilities === "object" ? m.capabilities : {};
    bits.push(caps.desktop ? "desktop available" : "no desktop (headless)");
    if (m.os) bits.push(m.os);
    return bits.join(" · ");
  }
  document.getElementById("loadMachines").addEventListener("click", async function () {
    say("");
    var res = await apiGet("/mover/console/api/machines?accountId=" + encodeURIComponent(accountId()));
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { say("Could not load machines: " + (data.message || data.error || res.status)); return; }
    var list = document.getElementById("machineList");
    while (list.firstChild) list.removeChild(list.firstChild);
    var machines = data.machines || [];
    if (machines.length === 0) {
      list.textContent = "No machines enrolled for this account yet.";
      return;
    }
    machines.forEach(function (m) {
      var div = document.createElement("div");
      div.className = "mrow";
      var head = document.createElement("div");
      var dot = document.createElement("span");
      dot.className = "dot" + (m.online ? " on" : "");
      head.appendChild(dot);
      var name = document.createElement("strong");
      name.textContent = m.name || m.machineId;
      head.appendChild(name);
      div.appendChild(head);
      var meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = m.machineId + " · " + progressText(m);
      div.appendChild(meta);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "small";
      btn.textContent = "Scan and browse";
      btn.addEventListener("click", function () { scanMachine(m.machineId, m.name || m.machineId); });
      div.appendChild(btn);
      var caps2 = m.capabilities && typeof m.capabilities === "object" ? m.capabilities : {};
      if (m.deskSession && m.deskSession.state === "live") {
        var badge = document.createElement("span");
        badge.className = "meta";
        badge.textContent = " · background desktop live";
        head.appendChild(badge);
      }
      if (m.viewSession && m.viewSession.state === "live") {
        var vbadge = document.createElement("span");
        vbadge.className = "meta";
        vbadge.textContent = " · screen view live";
        head.appendChild(vbadge);
      }
      if (m.online && caps2.backgroundDesktop) {
        var openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "small";
        openBtn.style.marginLeft = "0.5rem";
        openBtn.textContent = "Open background desktop";
        openBtn.addEventListener("click", function () {
          location.href = "/mover/console/desk/" + encodeURIComponent(m.machineId) +
            "?key=" + encodeURIComponent(key) +
            "&accountId=" + encodeURIComponent(accountId());
        });
        div.appendChild(openBtn);
      }
      if (m.online && caps2.viewScreen) {
        var viewBtn = document.createElement("button");
        viewBtn.type = "button";
        viewBtn.className = "small";
        viewBtn.style.marginLeft = "0.5rem";
        viewBtn.textContent = "View screen";
        if (!m.interactiveUser) {
          viewBtn.disabled = true;
          viewBtn.title = "No one is signed in on this machine";
          var noUser = document.createElement("span");
          noUser.className = "meta";
          noUser.textContent = " no one is signed in";
          div.appendChild(viewBtn);
          div.appendChild(noUser);
        } else {
          viewBtn.addEventListener("click", function () {
            location.href = "/mover/console/view/" + encodeURIComponent(m.machineId) +
              "?key=" + encodeURIComponent(key) +
              "&accountId=" + encodeURIComponent(accountId());
          });
          div.appendChild(viewBtn);
        }
      }
      list.appendChild(div);
    });
  });
  document.getElementById("rescan").addEventListener("click", function () {
    if (hm.machineId) scanMachine(hm.machineId, hm.machineName);
  });

  async function expandPaths(prefix) {
    if (hm.pathsCache[prefix]) return hm.pathsCache[prefix];
    var result = await queueAndWait(hm.machineId, "paths", { prefix: prefix });
    var list = Array.isArray(result) ? result : ((result && result.paths) || []);
    hm.pathsCache[prefix] = list;
    return list;
  }
  document.getElementById("reviewStart").addEventListener("click", async function () {
    if (!hm.machineId) { say("Scan a machine first."); return; }
    var totals = selectedAggTotals();
    if (totals.count <= 0) { say("Tick at least one folder or file first."); return; }
    say("Expanding the selection to the exact file list...");
    try {
      var parts = selParts();
      var seen = {}, paths = [];
      async function addAll(prefix) {
        if (aggOf(prefix).kind === "file") {
          if (!seen[prefix]) { seen[prefix] = true; paths.push(prefix); }
          return;
        }
        (await expandPaths(prefix)).forEach(function (p) {
          if (!seen[p]) { seen[p] = true; paths.push(p); }
        });
      }
      async function removeAll(prefix) {
        if (aggOf(prefix).kind === "file") { delete seen[prefix]; return; }
        (await expandPaths(prefix)).forEach(function (p) { delete seen[p]; });
      }
      for (var i = 0; i < parts.primary.length; i++) await addAll(parts.primary[i]);
      for (var j = 0; j < parts.exc.length; j++) await removeAll(parts.exc[j]);
      for (var k = 0; k < parts.reInc.length; k++) await addAll(parts.reInc[k]);
      paths = paths.filter(function (p) { return seen[p]; });
      pendingStart = { paths: paths, count: paths.length, bytes: totals.bytes };
      var name = document.getElementById("moveName").value.trim() || ("Move from " + hm.machineName);
      document.getElementById("confirmText").textContent =
        "Move '" + name + "' from " + hm.machineName + ": " +
        pendingStart.count + " files, " + fmtBytes(pendingStart.bytes) +
        ". Confirming queues a signed start command with exactly this file list. " +
        "The machine begins only when it picks the command up.";
      document.getElementById("confirmPanel").style.display = "block";
      say("");
    } catch (e) {
      say("Could not expand the selection: " + e.message);
    }
  });
  document.getElementById("cancelStart").addEventListener("click", function () {
    document.getElementById("confirmPanel").style.display = "none";
    pendingStart = null;
  });
  document.getElementById("confirmStart").addEventListener("click", async function () {
    if (!pendingStart) return;
    var name = document.getElementById("moveName").value.trim() || ("Move from " + hm.machineName);
    var res = await machineApi(hm.machineId, "start", {
      accountId: accountId(),
      moveName: name,
      paths: pendingStart.paths
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { say("Start failed: " + (data.message || data.error || res.status)); return; }
    document.getElementById("confirmPanel").style.display = "none";
    say("Signed start command queued for " + hm.machineName + " (" + data.commandId + "). " +
      "It carries the " + pendingStart.count + " files you confirmed.");
    pendingStart = null;
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
  app: FastifyInstance,
  options: { moverStore?: MoverStore } = {}
): Promise<void> {
  const consoleKey = process.env.MOVER_CONSOLE_KEY ?? "";
  const pairs: ConsolePair[] = [];
  const store = options.moverStore;

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

  // ----------------------------------------------------------------
  // Headless machines: the operator API. Same console gate as every
  // other console endpoint (the onRequest hook plus the per-handler
  // check). Machines are account-scoped: a machine enrolled under
  // another account reads as not found here.
  // ----------------------------------------------------------------

  function needStore(reply: FastifyReply): MoverStore | undefined {
    if (!store) {
      reply.code(501).send({
        error: "STORE_NOT_CONFIGURED",
        message:
          "This server was started without the mover store, so headless machines are unavailable."
      });
      return undefined;
    }
    return store;
  }

  function consoleAccountId(
    reply: FastifyReply,
    body: Record<string, unknown> | null,
    query: Record<string, unknown> | null
  ): string | undefined {
    const raw = String(body?.accountId ?? query?.accountId ?? "");
    if (!ACCOUNT_ID_RE.test(raw)) {
      reply.code(400).send({
        error: "INVALID_ACCOUNT",
        message: "accountId must be 8-64 URL-safe characters."
      });
      return undefined;
    }
    return raw;
  }

  function machineNotFound(reply: FastifyReply) {
    return reply.code(404).send({
      error: "MACHINE_NOT_FOUND",
      message: "No such machine for this account."
    });
  }

  app.get("/mover/console/api/machines", async (request, reply) => {
    if (!gate(request, reply)) return;
    const st = needStore(reply);
    if (!st) return;
    const acc = consoleAccountId(
      reply,
      null,
      (request.query ?? {}) as Record<string, unknown>
    );
    if (!acc) return;
    return { machines: st.listHeadlessMachines(acc) };
  });

  /** Queue one command for a machine; 404 when it is not enrolled. */
  function queueFor(
    reply: FastifyReply,
    st: MoverStore,
    acc: string,
    rawMachineId: string,
    type: string,
    payload: Record<string, unknown>
  ) {
    const cmd = isValidHeadlessMachineId(rawMachineId)
      ? st.queueHeadlessCommand(acc, rawMachineId, type, payload)
      : undefined;
    if (!cmd) return machineNotFound(reply);
    return { commandId: cmd.id };
  }

  app.post(
    "/mover/console/api/machines/:machineId/scan",
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      const params = request.params as { machineId: string };
      return queueFor(reply, st, acc, params.machineId, "scan", {});
    }
  );

  app.post(
    "/mover/console/api/machines/:machineId/browse",
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      const payload: Record<string, unknown> = {
        prefix: typeof body.prefix === "string" ? body.prefix : ""
      };
      if (typeof body.offset === "number" && Number.isFinite(body.offset)) {
        payload.offset = body.offset;
      }
      if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
        payload.limit = body.limit;
      }
      const params = request.params as { machineId: string };
      return queueFor(reply, st, acc, params.machineId, "browse", payload);
    }
  );

  app.post(
    "/mover/console/api/machines/:machineId/paths",
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      const payload: Record<string, unknown> = {
        prefix: typeof body.prefix === "string" ? body.prefix : ""
      };
      const params = request.params as { machineId: string };
      return queueFor(reply, st, acc, params.machineId, "paths", payload);
    }
  );

  app.get(
    "/mover/console/api/machines/:machineId/result/:commandId",
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const acc = consoleAccountId(
        reply,
        null,
        (request.query ?? {}) as Record<string, unknown>
      );
      if (!acc) return;
      const params = request.params as {
        machineId: string;
        commandId: string;
      };
      const cmd = st.getHeadlessCommand(acc, params.commandId);
      if (!cmd || cmd.machineId !== params.machineId) {
        return reply.code(404).send({
          error: "COMMAND_NOT_FOUND",
          message: "No such command for this machine and account."
        });
      }
      return {
        commandId: cmd.id,
        type: cmd.type,
        status: cmd.status,
        result: cmd.result ?? null
      };
    }
  );

  app.post(
    "/mover/console/api/machines/:machineId/start",
    { bodyLimit: 64 * 1024 * 1024 },
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      // The operator-verification rule, enforced server-side: a
      // start carries the exact concrete path list the operator
      // confirmed in the page. No paths, no start.
      const paths = body.paths;
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.some((p) => typeof p !== "string" || p === "")
      ) {
        return reply.code(400).send({
          error: "EMPTY_SELECTION",
          message:
            "A start needs the verified path list: at least one path the operator confirmed."
        });
      }
      const moveName =
        typeof body.moveName === "string" && body.moveName !== ""
          ? body.moveName
          : "Headless move";
      const params = request.params as { machineId: string };
      const cmd = isValidHeadlessMachineId(params.machineId)
        ? st.queueHeadlessCommand(acc, params.machineId, "start", {
            moveName,
            paths
          })
        : undefined;
      if (!cmd) return machineNotFound(reply);
      return { commandId: cmd.id, signature: cmd.signature };
    }
  );

  // ----------------------------------------------------------------
  // Background Admin (desk) operator API. Same console gate and
  // account scoping as the rest of the machines API. desk-end is
  // queued exactly like start: the store signs it with the
  // machine's secret at queue time, and this console channel is
  // the ONLY place it can be queued (the machine channel in
  // mover-headless.ts has no enqueue route at all, and the Viewer
  // app queues through the same operator door). The person at the
  // machine has no local surface for any of this.
  // ----------------------------------------------------------------

  function deskQueue(
    type: string,
    buildPayload: (body: Record<string, unknown>) => Record<string, unknown> | null
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      const payload = buildPayload(body);
      if (payload === null) {
        return reply.code(400).send({
          error: "BAD_DESK_PAYLOAD",
          message: "The desk command payload was not usable."
        });
      }
      const params = request.params as { machineId: string };
      return queueFor(reply, st, acc, params.machineId, type, payload);
    };
  }

  app.post(
    "/mover/console/api/machines/:machineId/desk-open",
    deskQueue("desk-open", (body) => {
      const payload: Record<string, unknown> = {};
      if (typeof body.width === "number" && Number.isFinite(body.width)) {
        payload.width = body.width;
      }
      if (typeof body.height === "number" && Number.isFinite(body.height)) {
        payload.height = body.height;
      }
      if (Array.isArray(body.launch)) {
        payload.launch = body.launch.filter((p) => typeof p === "string");
      }
      return payload;
    })
  );

  app.post(
    "/mover/console/api/machines/:machineId/desk-frame",
    deskQueue("desk-frame", () => ({}))
  );

  app.post(
    "/mover/console/api/machines/:machineId/desk-input",
    deskQueue("desk-input", (body) => {
      if (!Array.isArray(body.events)) return null;
      return { events: body.events.slice(0, 256) };
    })
  );

  app.post(
    "/mover/console/api/machines/:machineId/desk-launch",
    deskQueue("desk-launch", (body) => {
      if (typeof body.program !== "string" || body.program === "") return null;
      return {
        program: body.program,
        args: Array.isArray(body.args)
          ? body.args.filter((a) => typeof a === "string")
          : []
      };
    })
  );

  app.post(
    "/mover/console/api/machines/:machineId/desk-end",
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      const params = request.params as { machineId: string };
      const cmd = isValidHeadlessMachineId(params.machineId)
        ? st.queueHeadlessCommand(acc, params.machineId, "desk-end", {})
        : undefined;
      if (!cmd) return machineNotFound(reply);
      return { commandId: cmd.id, signature: cmd.signature };
    }
  );

  app.get(
    "/mover/console/api/machines/:machineId/desk-session",
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const acc = consoleAccountId(
        reply,
        null,
        (request.query ?? {}) as Record<string, unknown>
      );
      if (!acc) return;
      const params = request.params as { machineId: string };
      const view = st
        .listHeadlessMachines(acc)
        .find((m) => m.machineId === params.machineId);
      if (!view) return machineNotFound(reply);
      return { deskSession: view.deskSession };
    }
  );

  // The browser mirror of the one viewer implementation: the
  // RelaynAdminViewer app is the primary door; this page is the
  // same protocol (desk-open, desk-frame, desk-input, desk-launch,
  // desk-end through the console API above) for an operator who is
  // already in the console. The End session button here is, with
  // the Viewer app's, the only end control anywhere.
  app.get("/mover/console/desk/:machineId", async (request, reply) => {
    if (!gate(request, reply)) return;
    return reply.header("content-type", "text/html").send(DESK_VIEWER_HTML);
  });

  // ----------------------------------------------------------------
  // View Screen (view) operator API. Same gate and account
  // scoping as the desk API. The family is deliberately smaller:
  // view-open, view-frame, view-end. There is no view-input
  // route here, in the store, or in the engine: view-only is a
  // product rule, not a UI choice. view-end is signed at queue
  // time like desk-end, and this channel is the only place it
  // can be queued.
  // ----------------------------------------------------------------

  function viewQueue(type: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      const params = request.params as { machineId: string };
      return queueFor(reply, st, acc, params.machineId, type, {});
    };
  }

  app.post(
    "/mover/console/api/machines/:machineId/view-open",
    viewQueue("view-open")
  );

  app.post(
    "/mover/console/api/machines/:machineId/view-frame",
    viewQueue("view-frame")
  );

  app.post(
    "/mover/console/api/machines/:machineId/view-end",
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      const params = request.params as { machineId: string };
      const cmd = isValidHeadlessMachineId(params.machineId)
        ? st.queueHeadlessCommand(acc, params.machineId, "view-end", {})
        : undefined;
      if (!cmd) return machineNotFound(reply);
      return { commandId: cmd.id, signature: cmd.signature };
    }
  );

  app.get(
    "/mover/console/api/machines/:machineId/view-session",
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const acc = consoleAccountId(
        reply,
        null,
        (request.query ?? {}) as Record<string, unknown>
      );
      if (!acc) return;
      const params = request.params as { machineId: string };
      const view = st
        .listHeadlessMachines(acc)
        .find((m) => m.machineId === params.machineId);
      if (!view) return machineNotFound(reply);
      return { viewSession: view.viewSession, interactiveUser: view.interactiveUser };
    }
  );

  // The console mirror of the Viewer's View screen page: the
  // same protocol (view-open, view-frame, view-end) with no
  // input wiring of any kind.
  app.get("/mover/console/view/:machineId", async (request, reply) => {
    if (!gate(request, reply)) return;
    return reply.header("content-type", "text/html").send(VIEW_VIEWER_HTML);
  });
}

// -------------------------------------------------------------------------
// The console's Background Admin viewer page. Self-contained, in the
// console's visual language. Frames are pulled one command at a time
// (desk-frame request and response): roughly a frame a second over
// this channel, which is the honest v1 rate, not a video stream.
// -------------------------------------------------------------------------

const DESK_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Relayn Background Desktop</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; color: #1a1a1a; }
  button { padding: 0.6rem 1.2rem; border-radius: 8px; border: 0; background: #AC244D; color: #fff; cursor: pointer; font-size: 1rem; }
  button.ghost { background: #eee; color: #1a1a1a; }
  button.small { padding: 0.25rem 0.7rem; font-size: 0.9rem; }
  #status { white-space: pre-wrap; margin: 1rem 0; color: #7a102f; }
  #frame { width: 100%; display: block; border: 1px solid #ccc; border-radius: 8px; background: #17130F; cursor: crosshair; }
  #frame:focus-visible { outline: 2px solid #AC244D; outline-offset: 2px; }
  .row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin: 0.8rem 0; }
  input[type=text] { padding: 0.5rem; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
  .meta { color: #555; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>Background desktop</h1>
<p class="meta" id="who"></p>
<div id="status"></div>
<img id="frame" tabindex="0" alt="Background desktop frame">
<div class="row">
  <input type="text" id="prog" placeholder="Program to launch, for example notepad" size="34">
  <input type="text" id="args" placeholder="Arguments (optional)" size="24">
  <button type="button" class="ghost" id="launch">Launch</button>
  <span style="flex:1"></span>
  <button type="button" id="end">End session</button>
</div>
<p class="meta">Click the picture to click on the private desktop. Type while the
picture has focus to type there. Scrolling over the picture scrolls there.
Ending the session here is final: the desktop and everything open on it closes.</p>
<script>
  var qs = new URLSearchParams(location.search);
  var key = qs.get("key") || "";
  var accountId = qs.get("accountId") || "";
  var machineId = decodeURIComponent(location.pathname.split("/").pop() || "");
  var statusEl = document.getElementById("status");
  var img = document.getElementById("frame");
  function say(msg) { statusEl.textContent = msg || ""; }
  document.getElementById("who").textContent =
    "Machine " + machineId + " · account " + accountId;
  var session = null, frameW = 0, frameH = 0, gen = 0, timer = null;
  function headers() { return { "Content-Type": "application/json", "X-Console-Key": key }; }
  async function api(path, body) {
    var res = await fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body || {}) });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
    return data;
  }
  async function queue(action, body) {
    body = body || {};
    body.accountId = accountId;
    var data = await api("/mover/console/api/machines/" + encodeURIComponent(machineId) + "/" + action, body);
    return data.commandId;
  }
  async function waitResult(commandId) {
    for (var i = 0; i < 100; i++) {
      var res = await fetch(
        "/mover/console/api/machines/" + encodeURIComponent(machineId) +
        "/result/" + encodeURIComponent(commandId) +
        "?accountId=" + encodeURIComponent(accountId),
        { headers: { "X-Console-Key": key } }
      );
      if (res.ok) {
        var data = await res.json();
        if (data.status === "done") return data.result;
      }
      await new Promise(function (r) { setTimeout(r, 1000); });
    }
    throw new Error("Timed out waiting for the machine to answer.");
  }
  async function start() {
    try {
      var id = await queue("desk-open", { width: 1280, height: 800 });
      var res = await waitResult(id);
      if (res && res.error) throw new Error(res.error);
      session = res;
      say("Session live. Frames are pulled one at a time, about one a second.");
      img.focus();
      runFrames(++gen);
    } catch (e) { say("Could not open the desktop: " + e.message); }
  }
  async function runFrames(g) {
    if (g !== gen || !session) return;
    try {
      var id = await queue("desk-frame", {});
      var res = await waitResult(id);
      if (g !== gen || !session) return;
      if (res && res.data) {
        img.src = "data:image/jpeg;base64," + res.data;
        frameW = res.width || frameW; frameH = res.height || frameH;
        say("Session live · frame " + (res.seq || 0) + " · " + (res.framesServed || 0) + " frames served");
      } else if (res && res.error) {
        say("Frame failed: " + res.error);
      }
    } catch (e) {
      if (g === gen) say("Frame failed: " + e.message);
    }
    if (g === gen && session) timer = setTimeout(function () { runFrames(g); }, 150);
  }
  async function sendInput(events) {
    if (!session) return;
    try { var id = await queue("desk-input", { events: events }); await waitResult(id); }
    catch (e) { /* the next frame shows the truth either way */ }
  }
  function coords(e) {
    var r = img.getBoundingClientRect();
    var w = frameW || r.width, h = frameH || r.height;
    return {
      x: Math.max(0, Math.round((e.clientX - r.left) * w / r.width)),
      y: Math.max(0, Math.round((e.clientY - r.top) * h / r.height))
    };
  }
  function btnName(b) { return b === 2 ? "right" : (b === 1 ? "middle" : "left"); }
  img.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  img.addEventListener("mousedown", function (e) {
    img.focus();
    var c = coords(e);
    sendInput([{ kind: "move", x: c.x, y: c.y }, { kind: "down", x: c.x, y: c.y, button: btnName(e.button) }]);
  });
  img.addEventListener("mouseup", function (e) {
    var c = coords(e);
    sendInput([{ kind: "up", x: c.x, y: c.y, button: btnName(e.button) }]);
  });
  img.addEventListener("wheel", function (e) {
    e.preventDefault();
    var c = coords(e);
    sendInput([{ kind: "wheel", x: c.x, y: c.y, delta: e.deltaY > 0 ? -120 : 120 }]);
  }, { passive: false });
  var named = { Enter: "Enter", Escape: "Escape", Backspace: "Backspace", Tab: "Tab",
    Delete: "Delete", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ArrowLeft: "Left", ArrowUp: "Up", ArrowRight: "Right", ArrowDown: "Down",
    Shift: "Shift", Control: "Control", Alt: "Alt", " ": "Space" };
  img.addEventListener("keydown", function (e) {
    if (!session) return;
    if (named[e.key] || (e.key && e.key.length > 1)) {
      e.preventDefault();
      var k = named[e.key] || e.key;
      sendInput([{ kind: "keydown", key: k }, { kind: "keyup", key: k }]);
    } else if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      sendInput([{ kind: "text", text: e.key }]);
    }
  });
  document.getElementById("launch").addEventListener("click", async function () {
    var prog = document.getElementById("prog").value.trim();
    if (!prog || !session) return;
    var argsRaw = document.getElementById("args").value.trim();
    try {
      var id = await queue("desk-launch", { program: prog, args: argsRaw ? argsRaw.split(/\\s+/) : [] });
      var res = await waitResult(id);
      if (res && res.error) say("Launch failed: " + res.error);
    } catch (e) { say("Launch failed: " + e.message); }
  });
  document.getElementById("end").addEventListener("click", async function () {
    gen++;
    if (timer) { clearTimeout(timer); timer = null; }
    var was = session;
    session = null;
    try {
      var id = await queue("desk-end", {});
      var res = await waitResult(id);
      if (res && res.error) say("End failed: " + res.error);
      else say("Session ended. The private desktop is closed.");
    } catch (e) { say("End failed: " + e.message); }
    void was;
  });
  start();
</script>
</body>
</html>
`;

// -------------------------------------------------------------------------
// The console's View Screen page. The desk viewer's twin in shape,
// and deliberately emptier: the frame image carries NO input
// listeners of any kind, because the view protocol has no input.
// Frames are pulled one command at a time (view-frame request and
// response), about one a second, the honest v1 rate.
// -------------------------------------------------------------------------

const VIEW_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Relayn View Screen</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; color: #1a1a1a; }
  button { padding: 0.6rem 1.2rem; border-radius: 8px; border: 0; background: #AC244D; color: #fff; cursor: pointer; font-size: 1rem; }
  #status { white-space: pre-wrap; margin: 1rem 0; color: #7a102f; }
  #frame { width: 100%; display: block; border: 1px solid #ccc; border-radius: 8px; background: #17130F; }
  .row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin: 0.8rem 0; }
  .meta { color: #555; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>View screen</h1>
<p class="meta" id="who"></p>
<p><strong>You are only viewing this screen.</strong> Nothing here can click,
type or change anything on it. The view ends only when you end it here, when
it sits idle too long, or when the person signs out.</p>
<div id="status"></div>
<img id="frame" alt="The signed-in screen, view only">
<div class="row">
  <span style="flex:1"></span>
  <button type="button" id="end">End view</button>
</div>
<script>
  var qs = new URLSearchParams(location.search);
  var key = qs.get("key") || "";
  var accountId = qs.get("accountId") || "";
  var machineId = decodeURIComponent(location.pathname.split("/").pop() || "");
  var statusEl = document.getElementById("status");
  var img = document.getElementById("frame");
  function say(msg) { statusEl.textContent = msg || ""; }
  document.getElementById("who").textContent =
    "Machine " + machineId + " · account " + accountId;
  var session = null, gen = 0, timer = null;
  function headers() { return { "Content-Type": "application/json", "X-Console-Key": key }; }
  async function api(path, body) {
    var res = await fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body || {}) });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
    return data;
  }
  async function queue(action, body) {
    body = body || {};
    body.accountId = accountId;
    var data = await api("/mover/console/api/machines/" + encodeURIComponent(machineId) + "/" + action, body);
    return data.commandId;
  }
  async function waitResult(commandId) {
    for (var i = 0; i < 100; i++) {
      var res = await fetch(
        "/mover/console/api/machines/" + encodeURIComponent(machineId) +
        "/result/" + encodeURIComponent(commandId) +
        "?accountId=" + encodeURIComponent(accountId),
        { headers: { "X-Console-Key": key } }
      );
      if (res.ok) {
        var data = await res.json();
        if (data.status === "done") return data.result;
      }
      await new Promise(function (r) { setTimeout(r, 1000); });
    }
    throw new Error("Timed out waiting for the machine to answer.");
  }
  async function start() {
    try {
      var id = await queue("view-open", {});
      var res = await waitResult(id);
      if (res && res.error) throw new Error(res.error);
      session = res;
      document.getElementById("who").textContent =
        "Machine " + machineId + " · account " + accountId +
        " · signed in as " + (res.user || "unknown");
      say("Viewing the screen. Frames are pulled one at a time, about one a second.");
      runFrames(++gen);
    } catch (e) { say("Could not open the view: " + e.message); }
  }
  async function runFrames(g) {
    if (g !== gen || !session) return;
    try {
      var id = await queue("view-frame", {});
      var res = await waitResult(id);
      if (g !== gen || !session) return;
      if (res && res.data) {
        img.src = "data:image/jpeg;base64," + res.data;
        say("Viewing · frame " + (res.seq || 0) + " · " + (res.framesServed || 0) + " frames served");
      } else if (res && res.error) {
        say("Frame failed: " + res.error);
      }
    } catch (e) {
      if (g === gen) say("Frame failed: " + e.message);
    }
    if (g === gen && session) timer = setTimeout(function () { runFrames(g); }, 150);
  }
  document.getElementById("end").addEventListener("click", async function () {
    gen++;
    if (timer) { clearTimeout(timer); timer = null; }
    session = null;
    try {
      var id = await queue("view-end", {});
      var res = await waitResult(id);
      if (res && res.error) say("End failed: " + res.error);
      else say("View ended.");
    } catch (e) { say("End failed: " + e.message); }
  });
  start();
</script>
</body>
</html>
`;
