// =========================================================================
// RELAYN MOVER — online console (Fastify plugin, TypeScript)
// -------------------------------------------------------------------------
// A page on this server where the owner makes Mover pairs anytime,
// without touching the cloud himself:
//
//   GET  /mover/console                  the console page (HTML): one
//                                        tabbed shell, Overview, EXT,
//                                        MOVER and ADMIN
//   GET  /mover/console/api/overview     counts + machines + moves +
//                                        EXT activity across accounts
//   GET  /mover/console/api/moves        cloud moves across accounts
//   GET  /mover/console/api/licenses     the license registry
//   POST /mover/console/api/licenses     issue a license
//   POST /mover/console/api/licenses/revoke   revoke a license
//   POST /mover/console/api/licenses/restore  restore a license
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
//   POST /mover/console/api/machines/:id/files-browse    queue a files-browse
//   POST /mover/console/api/machines/:id/files-fetch     queue a SIGNED files-fetch
//   POST /mover/console/api/machines/:id/files-push      queue a SIGNED files-push
//   GET  /mover/console/api/files-ledger                 Files transfer ledger
//   POST /mover/console/api/machines/:id/anchor-update   queue a SIGNED anchor-update
//   POST /mover/console/api/machines/:id/anchor-deliver  queue a SIGNED anchor-deliver
//   GET  /mover/console/api/anchor-ledger                anchor deed ledger
//
// The files-fetch payload carries concrete files only, exactly like
// start: the console expands ticked folders through "paths", shows
// the exact list in a confirmation step, and only then is the signed
// fetch queued. files-fetch and files-push queueing is license gated
// (a revoked license for the account answers 403); files-browse is
// read-only and stays ungated, like scan and browse. A machine that
// posts a files-fetch or files-push result with a "transfers" array
// folds those entries into the Files transfer ledger the ADMIN tab
// shows (see mover-store.ts: noteFilesTransfers).
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
import { promises as fs, readFileSync, statSync } from "node:fs";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { BackupStore } from "./backup-store.js";
import {
  isLicenseProduct,
  type LicenseProduct,
  type LicenseStore
} from "./license-store.js";
import { isValidHeadlessMachineId, type MoverStore } from "./mover-store.js";
import type { ShareStore } from "./share-store.js";

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
  anchorDisabled: "The anchor is turned off on this machine.",
  viewerBuildStamp: "build {stamp}",
  viewerAnchorLast: "Anchor: {outcome}",
  filesTitle: "Files",
  filesDisabled: "Files is turned off on this machine.",
  filesEmpty: "No files here yet.",
  filesBrowse: "Browse files",
  filesDownload: "Download",
  filesUpload: "Upload",
  filesFetchConfirm: "Check this list, then confirm. Nothing moves until you confirm.",
  filesPushDone: "File written to the machine.",
  filesConfirmFetch: "Review the files below. Nothing moves until you confirm.",
  filesSaveTo: "Save downloads to",
  filesDestFolder: "Destination folder on that machine",
  continuityTitle: "Continuity: how this machine feels now",
  readyNow: "Ready now",
  needsAttention: "Needs your attention",
  partsPrompt:
    "Pack paths to import, comma separated (example: documents/report.pdf, pictures/cat.jpg). Leave a category out to import the rest later."
};

export type MoverRole = "mover" | "admin" | "host" | "viewer";

export interface MoverPairOptions {
  accountId: string;
  role: MoverRole;
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
  const role: MoverRole =
    opts.role === "admin" ||
    opts.role === "host" ||
    opts.role === "viewer"
      ? opts.role
      : "mover";
  // Feature sets are derived from the role, matching the Go apps:
  // mover moves, admin receives and imports, and host and viewer
  // always derive the empty feature set (a host only serves its
  // background desktop, a viewer only watches; the config template
  // below already carries the headless enroll, desk and view blocks
  // both of them run on).
  const derivedFeatures =
    role === "admin"
      ? { move: false, inbox: true, import: true }
      : role === "mover"
        ? { move: true, inbox: false, import: false }
        : { move: false, inbox: false, import: false };
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
    // Files defaults: the on-demand file door (browse, fetch and
    // push) on a machine. An empty downloadDir means the app's own
    // default download folder.
    files: { enabled: true, downloadDir: "" },
    // Anchor defaults: the planted Host as the suite's SYSTEM
    // carrier (self-update + sibling delivery on signed operator
    // command). An empty suiteDir means <dataDir>/suite;
    // updateProofSec bounds the updater's wait for the new
    // build's proof before it rolls back.
    anchor: { enabled: true, suiteDir: "", updateProofSec: 120 },
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
  if (
    c.role !== "mover" &&
    c.role !== "admin" &&
    c.role !== "host" &&
    c.role !== "viewer"
  ) {
    errors.push("role must be mover, admin, host or viewer");
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
// Roles, products and download names. The console sells three
// products (ext, mover, admin) but builds four roles: host and
// viewer are admin-side builds, so their downloads are gated by the
// admin license.
// -------------------------------------------------------------------------

export function productForRole(role: MoverRole): LicenseProduct {
  if (role === "mover") return "mover";
  return "admin"; // admin, host and viewer are all the admin product
}

export function packageFilename(role: MoverRole): string {
  switch (role) {
    case "admin":
      return "relayn-mover-admin.exe";
    case "host":
      return "relayn-host.exe";
    case "viewer":
      return "relayn-admin-viewer.exe";
    default:
      return "relayn-mover.exe";
  }
}

// -------------------------------------------------------------------------
// Build stamps and anchor downloads. A shipped base exe carries
// its build stamp exactly once (the linker writes
// -X main.buildStamp=YYYYMMDDHHMM as a 12 digit string into the
// binary). extractBuildStamp mirrors the Go implementation
// (internal/config/stamp_extract.go) byte for byte in behaviour:
// scan for ASCII runs shaped 20 + 10 digits, bounded by
// non-digits, that parse as a plausible date and time, and take
// the numerically largest. The anchor verifies a fetched build
// the same way on its side; the two must stay in step.
// -------------------------------------------------------------------------

export function extractBuildStamp(data: Buffer): string {
  let best = "";
  for (let i = 0; i + 12 <= data.length; i++) {
    if (data[i] !== 0x32 || data[i + 1] !== 0x30) continue; // "20"
    let ok = true;
    for (let j = 2; j < 12; j++) {
      const b = data[i + j];
      if (b < 0x30 || b > 0x39) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (i > 0 && data[i - 1] >= 0x30 && data[i - 1] <= 0x39) continue;
    if (
      i + 12 < data.length &&
      data[i + 12] >= 0x30 &&
      data[i + 12] <= 0x39
    ) {
      continue;
    }
    const cand = data.toString("ascii", i, i + 12);
    const month = Number(cand.slice(4, 6));
    const day = Number(cand.slice(6, 8));
    const hour = Number(cand.slice(8, 10));
    const minute = Number(cand.slice(10, 12));
    if (
      month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59
    ) {
      continue;
    }
    if (cand > best) best = cand;
  }
  return best;
}

let servedStampCache = { key: "", stamp: "" };

/**
 * The build stamp of the base exe this server currently serves
 * ("" when MOVER_BASE_EXE is unset, unreadable, or the base
 * carries no stamp). Cached on the file's path+size+mtime so
 * the machines list can carry it on every read without
 * re-reading ~10 MB each time.
 */
export function servedBuildStamp(): string {
  const baseExe = process.env.MOVER_BASE_EXE ?? "";
  if (!baseExe) return "";
  try {
    const st = statSync(baseExe);
    const key = `${baseExe}:${st.size}:${Math.floor(st.mtimeMs)}`;
    if (servedStampCache.key === key) return servedStampCache.stamp;
    const stamp = extractBuildStamp(readFileSync(baseExe));
    servedStampCache = { key, stamp };
    return stamp;
  } catch {
    return "";
  }
}

export type BuildRoleResult =
  | { ok: true; bytes: Buffer; stamp: string; filename: string }
  | { ok: false; status: number; error: string; message: string };

/**
 * Build one role's ready exe for one account: the pair
 * download's construction (base exe + that account's merged
 * config as the inbuilt overlay), shared by the console
 * package download and the anchor's machine-authenticated
 * build endpoint (mover-headless.ts). The license gate stays
 * with the callers: both refuse revoked products before
 * building, in their own shapes.
 */
export async function buildRoleExe(
  role: MoverRole,
  accountId: string
): Promise<BuildRoleResult> {
  const baseExe = process.env.MOVER_BASE_EXE ?? "";
  if (!baseExe) {
    return {
      ok: false,
      status: 501,
      error: "BASE_EXE_NOT_CONFIGURED",
      message:
        "MOVER_BASE_EXE is not set on this server, so ready builds are unavailable. The config.json download still works."
    };
  }
  let exe: Buffer;
  try {
    exe = await fs.readFile(baseExe);
  } catch {
    return {
      ok: false,
      status: 500,
      error: "BASE_EXE_UNREADABLE",
      message: "The base app file configured on this server could not be read."
    };
  }
  const cfg = buildMoverConfig({ accountId, role });
  const check = validateMoverConfig(cfg);
  if (!check.ok) {
    return {
      ok: false,
      status: 400,
      error: "INVALID_CONFIG",
      message: check.errors.join("; ")
    };
  }
  const bytes = buildInbuiltExe(
    exe,
    Buffer.from(JSON.stringify(cfg, null, 1), "utf8")
  );
  return { ok: true, bytes, stamp: extractBuildStamp(exe), filename: packageFilename(role) };
}

// -------------------------------------------------------------------------
// Shared console styling. One visual language for every console
// page (the tabbed console, the background desktop viewer and the
// view screen viewer), matching the Go apps: cream background,
// white cards, burgundy primary, gold accent. The fonts are
// self-hosted in the truest sense: Aeonik Pro Bold for headings
// and Figtree for body text, embedded here as base64 data URIs
// (about 107 KB). Nothing is ever loaded from a font CDN.
// -------------------------------------------------------------------------

const FONT_FACE_CSS = `@font-face{font-family:"Aeonik Pro Bold";src:url(data:font/woff2;base64,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) format("woff2");font-weight:700;font-style:normal;font-display:swap;}@font-face{font-family:"Figtree";src:url(data:font/woff2;base64,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) format("woff2");font-weight:100 900;font-style:normal;font-display:swap;}`;

const SHARED_CSS = FONT_FACE_CSS + `
:root{--bg:#FDF9F6;--surface:#FFFFFF;--surface2:#FFFDFB;--ink:#1A1A1A;--muted:#6E6259;--border:#EAE0D4;--border2:#EADFD2;--primary:#AC244D;--primary-dark:#7a102f;--gold:#C9A84C;--ok:#137333;--ok-bg:#e6f4ea;--warn:#7A4D00;--warn-bg:#FDF3DF;--err:#8C2B1F;--err-bg:#FDECEA;--radius:12px;}
*{box-sizing:border-box;}
body{font-family:"Figtree",system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.5;margin:0 auto;padding:0 1rem 3rem;}
h1,h2,h3{font-family:"Aeonik Pro Bold","Figtree",sans-serif;}
h1{font-size:28px;margin:0;}
h2{font-size:20px;margin:0 0 0.4rem;}
h3{font-size:16px;margin:0 0 0.4rem;}
p{margin:0.5rem 0;}
fieldset,.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 1px 3px rgba(26,26,26,0.06);padding:1rem 1.1rem;margin:1rem 0;}
legend{font-family:"Aeonik Pro Bold","Figtree",sans-serif;font-size:16px;padding:0 0.4rem;}
label{display:block;margin:0.45rem 0;font-size:14px;}
input[type=text],input[type=number],textarea,select{width:100%;padding:0.5rem 0.6rem;border:1px solid var(--border2);border-radius:10px;background:var(--surface2);color:var(--ink);font:inherit;font-size:14px;}
input[type=color]{width:3rem;height:2.1rem;padding:0.1rem;border:1px solid var(--border2);border-radius:8px;background:#fff;cursor:pointer;}
button{padding:0.6rem 1.2rem;border-radius:10px;border:1px solid var(--primary);background:var(--primary);color:#fff;cursor:pointer;font:inherit;font-size:14px;font-weight:600;}
button.ghost{background:var(--surface);color:var(--ink);border-color:var(--border2);}
button.small{padding:0.3rem 0.75rem;font-size:13px;border-radius:8px;}
button:disabled{opacity:0.55;cursor:not-allowed;}
code{background:#f6efe8;padding:0.1rem 0.35rem;border-radius:6px;font-size:13px;word-break:break-all;}
.meta{color:var(--muted);font-size:12px;}
#status{white-space:pre-wrap;margin:1rem 0;color:var(--primary-dark);font-size:14px;}
.pill{display:inline-block;border-radius:999px;padding:0.12rem 0.6rem;font-size:12px;font-weight:600;line-height:1.5;white-space:nowrap;}
.pill.ok{background:var(--ok-bg);color:var(--ok);}
.pill.err{background:var(--err-bg);color:var(--err);}
.pill.warn{background:var(--warn-bg);color:var(--warn);}
.pill.mut{background:#f1e9df;color:var(--muted);}
table{width:100%;border-collapse:collapse;font-size:14px;}
th,td{text-align:left;padding:0.45rem 0.5rem;border-bottom:1px solid var(--border);vertical-align:top;}
th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;}
.row{display:flex;gap:1rem;flex-wrap:wrap;}
.row>label{flex:1;min-width:160px;}
.crow{display:flex;gap:0.5rem;align-items:center;}
.crow input[type=text]{flex:1;}
.brand{display:flex;align-items:center;gap:0.8rem;padding:1.4rem 0 0.2rem;}
.brand .mark{width:44px;height:44px;border-radius:12px;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-family:"Aeonik Pro Bold","Figtree",sans-serif;font-size:22px;flex:none;}
.subtitle{color:var(--muted);font-size:14px;margin:0.15rem 0 0;}
.tabs{display:flex;gap:0.5rem;flex-wrap:wrap;margin:1rem 0 0.2rem;border-bottom:2px solid var(--border);padding-bottom:0.6rem;}
.tabbtn{background:var(--surface);color:var(--ink);border:1px solid var(--border2);border-radius:999px;padding:0.45rem 1.1rem;font-weight:600;}
.tabbtn.active{background:var(--primary);border-color:var(--primary);color:#fff;}
.tabsection{display:none;}
.tabsection.active{display:block;}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0.8rem;margin:1rem 0;}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 1px 3px rgba(26,26,26,0.06);padding:0.9rem 1rem;}
.stat .num{font-family:"Aeonik Pro Bold","Figtree",sans-serif;font-size:26px;}
.stat .lab{color:var(--muted);font-size:12px;}
.honest{background:var(--warn-bg);border:1px solid #ecd9a8;border-radius:var(--radius);padding:0.9rem 1.1rem;margin:1rem 0;font-size:14px;}
.honest strong{color:var(--warn);}
.mrow{border:1px solid var(--border);border-radius:10px;padding:0.7rem 0.9rem;margin:0.5rem 0;background:var(--surface2);}
.mrow .meta{color:var(--muted);font-size:12px;}
.dot{display:inline-block;width:0.6rem;height:0.6rem;border-radius:50%;background:#cbbfae;margin-right:0.4rem;}
.dot.on{background:var(--ok);}
.trow{margin:0.2rem 0;font-size:14px;}
.trow .meta{color:var(--muted);font-size:12px;margin-left:0.4rem;}
.kids{margin-left:1.4rem;border-left:1px dotted var(--border2);padding-left:0.6rem;}
#confirmPanel{border:2px solid var(--primary);border-radius:var(--radius);padding:0.8rem;margin-top:0.8rem;background:var(--surface);}
#anchorPanel{border:2px solid var(--primary);border-radius:var(--radius);padding:0.8rem;margin-top:0.8rem;background:var(--surface);}
.ledger{border:1px solid var(--border);border-radius:10px;padding:0.6rem 0.8rem;margin:0.4rem 0;background:var(--surface);font-size:13px;}
`;

// -------------------------------------------------------------------------
// Console page. One self-contained HTML file; the key rides in the URL
// the owner opens and in the X-Console-Key header for API calls.
// -------------------------------------------------------------------------

const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relayn Console</title>
<style>
${SHARED_CSS}
  body { max-width: 980px; }
</style>
</head>
<body>
<header class="brand">
  <div class="mark">R</div>
  <div>
    <h1>Relayn Console</h1>
    <p class="subtitle">One console for every Relayn product: the extension, Mover pairs and Admin builds, with the license registry that gates them.</p>
  </div>
</header>
<div id="status"></div>
<nav class="tabs">
  <button type="button" class="tabbtn active" data-tab="overview">Overview</button>
  <button type="button" class="tabbtn" data-tab="ext">EXT</button>
  <button type="button" class="tabbtn" data-tab="mover">MOVER</button>
  <button type="button" class="tabbtn" data-tab="admin">ADMIN</button>
</nav>

<section id="tab-overview" class="tabsection active">
  <div class="cards">
    <div class="stat"><div class="num" id="ovLicActive">-</div><div class="lab">Licenses active</div></div>
    <div class="stat"><div class="num" id="ovLicRevoked">-</div><div class="lab">Licenses revoked</div></div>
    <div class="stat"><div class="num" id="ovMachines">-</div><div class="lab">Machines online / enrolled</div></div>
    <div class="stat"><div class="num" id="ovMoves">-</div><div class="lab">Cloud moves held</div></div>
    <div class="stat"><div class="num" id="ovPayloads">-</div><div class="lab">Live EXT payloads</div></div>
  </div>
  <p><button type="button" id="refreshOverview" class="ghost">Refresh overview</button></p>
  <div class="honest"><strong>Please note:</strong> licenses and enrollments live in server memory and reset on redeploy. Revoking a license blocks new enrollments and new build downloads for that account. It does not end machines or sessions that are already running.</div>
  <p class="meta">Counts come from this server only: the licenses it holds, the machines enrolled with it, the cloud moves on its disk, and the extension shares and backups it is holding right now.</p>
</section>

<section id="tab-ext" class="tabsection">
  <h2>EXT: the browser extension</h2>
  <p>The extension moves signed-in sessions between browsers: shares and encrypted backups are held by this server, and licenses decide which accounts may use it.</p>
<div class="card">
  <h3>EXT licenses</h3>
  <p>One license per account for the browser extension. Revoking blocks new enrollments and new downloads for that account and product. It does not end anything already running.</p>
  <div id="extLicenses"><p class="meta">Loading licenses.</p></div>
  <div class="row">
    <label>Label <input type="text" id="extLabel" placeholder="For example: Shop laptop"></label>
    <label>Account ID (optional) <input type="text" id="extAccountId" placeholder="Leave blank to mint a new account"></label>
  </div>
  <label>Note <input type="text" id="extNote" placeholder="Optional note"></label>
  <p><button type="button" id="extIssue">Issue EXT license</button></p>
</div>
<div class="card">
  <h3>EXT pair and config</h3>
  <p>Make an extension pair the same way as a Mover pair. Create a pair, set every option below, then download the config or the ready build for each side. The two sides share one account ID, that is what links them. The child build is share-only; the admin build adds scan and the incoming shares inbox. The ready build is one zip carrying the merged config inside it.</p>
  <p>Account ID: <code id="extPairAccountId">(none yet)</code></p>
  <p>
    <button type="button" id="extCreatePair">Create an EXT pair</button>
  </p>
  <label>Or use an existing account ID (leave blank for anonymous shares, no account)
    <input type="text" id="extPairAccountInput" placeholder="8-64 URL-safe characters, or blank">
  </label>

  <p><strong>Brand</strong></p>
  <div class="row">
    <label>Name <input type="text" id="extBrandName"></label>
    <label>Tagline <input type="text" id="extBrandTagline"></label>
  </div>
  <label>Bio <input type="text" id="extBrandBio"></label>
  <div class="row">
    <label>Primary colour
      <span class="crow"><input type="color" id="extColorPick" value="#1a73e8"><input type="text" id="extBrandColor"></span>
    </label>
    <label>Success background
      <span class="crow"><input type="color" id="extSuccessBgPick" value="#e6f4ea"><input type="text" id="extBrandSuccessBg"></span>
    </label>
    <label>Success colour
      <span class="crow"><input type="color" id="extSuccessPick" value="#137333"><input type="text" id="extBrandSuccess"></span>
    </label>
  </div>
  <div class="row">
    <label>Share button text <input type="text" id="extShareBtnText"></label>
    <label>Scan button text <input type="text" id="extScanBtnText"></label>
  </div>

  <p><strong>Server</strong></p>
  <label>Server URL (the address only, no path: the extension accepts nothing else)
    <input type="text" id="extServerUrl">
  </label>

  <p><strong>What a share carries</strong></p>
  <label><input type="checkbox" id="extFeatShare"> Share (the share button itself)</label>
  <label><input type="checkbox" id="extFeatServerCard"> Server card (lets the user see and change the server address in the popup)</label>
  <label><input type="checkbox" id="extFeatLocalStorage"> Site data (localStorage)</label>
  <label><input type="checkbox" id="extFeatHistory"> Browsing history</label>
  <label><input type="checkbox" id="extFeatIndexedDB"> App storage (IndexedDB)</label>
  <p class="meta">Scan and the incoming shares inbox are set by the side you download: the child never has them, the admin always does.</p>

  <details>
    <summary><strong>Messages</strong> (every text the extension shows; placeholders like {cookies} are filled in at run time)</summary>
    <div id="extMessages"><p class="meta">Loading the message list.</p></div>
  </details>

  <p><strong>Download for a side</strong></p>
  <div class="row">
    <label>Side
      <select id="extRole">
        <option value="child">Child (share only)</option>
        <option value="admin">Admin (share, scan, inbox)</option>
      </select>
    </label>
  </div>
  <p>
    <button type="button" id="extDlConfig">Download config.json</button>
    <button type="button" id="extDlZip" class="ghost">Download ready build (zip, config inbuilt)</button>
  </p>
</div>
  <div class="card">
    <h3>Extension activity on this server</h3>
    <div id="extActivity"><p class="meta">Loading activity.</p></div>
    <p class="meta">The activity shown is the share and backup activity this server actually holds.</p>
  </div>
</section>

<section id="tab-mover" class="tabsection">
  <h2>Relayn Mover Console</h2>
  <p>Make a Mover pair anytime. Create a pair, set the options, then download
the config or the ready build for each side. The two sides share one account
ID, that is what links them. The ready build is a single exe with the config
compiled in, nothing else to carry or place beside it.</p>
<div class="card">
  <h3>MOVER licenses</h3>
  <p>One license per account for the Mover side of a pair. Creating a pair below issues the mover and admin licenses for the new account automatically. Revoking blocks new enrollments and new downloads for that account and product.</p>
  <div id="moverLicenses"><p class="meta">Loading licenses.</p></div>
  <div class="row">
    <label>Label <input type="text" id="moverLabel" placeholder="For example: Shop laptop"></label>
    <label>Account ID (optional) <input type="text" id="moverAccountId" placeholder="Leave blank to mint a new account"></label>
  </div>
  <label>Note <input type="text" id="moverNote" placeholder="Optional note"></label>
  <p><button type="button" id="moverIssue">Issue MOVER license</button></p>
</div>
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
  <div id="anchorPanel" style="display:none">
    <p><strong id="anchorPanelTitle">Confirm anchor deed</strong></p>
    <p id="anchorText"></p>
    <p>
      <button id="anchorConfirm" type="button">Confirm</button>
      <button id="anchorCancel" type="button" class="ghost">Back</button>
    </p>
    <div id="anchorNote"></div>
  </div>
</fieldset>
  <div class="card">
    <h3>5. Cloud moves</h3>
    <p>Moves this server is holding across every known account, newest first. A move rests here, sealed, until the Admin side pulls it down.</p>
    <p><button type="button" id="loadMoves" class="ghost">Load cloud moves</button></p>
    <div id="cloudMoves"><p class="meta">Not loaded yet.</p></div>
  </div>
</section>

<section id="tab-admin" class="tabsection">
  <h2>ADMIN: Admin, Host and Viewer builds</h2>
  <p>The Admin side receives and imports moves. A Host build serves the background desktop, and a Viewer build is the admin viewer. All three are admin product downloads.</p>
<div class="card">
  <h3>ADMIN licenses</h3>
  <p>One license per account for the Admin side. The host and viewer downloads below are gated by this same admin license. Revoking blocks new enrollments and new downloads for that account and product.</p>
  <div id="adminLicenses"><p class="meta">Loading licenses.</p></div>
  <div class="row">
    <label>Label <input type="text" id="adminLabel" placeholder="For example: Shop laptop"></label>
    <label>Account ID (optional) <input type="text" id="licAdminAccount" placeholder="Leave blank to mint a new account"></label>
  </div>
  <label>Note <input type="text" id="adminNote" placeholder="Optional note"></label>
  <p><button type="button" id="adminIssue">Issue ADMIN license</button></p>
</div>
  <div class="card">
    <h3>Downloads: Admin, Host, Viewer</h3>
    <p>These downloads use the same options as section 2 in the MOVER tab (brand, transfer and restore settings). Pick a role, confirm the account, then download the config or the ready build.</p>
    <div class="row">
      <label>Role
        <select id="adminRole">
          <option value="admin">Admin (new machine)</option>
          <option value="host">Host (background desktop)</option>
          <option value="viewer">Viewer (admin viewer)</option>
        </select>
      </label>
      <label>Account ID <input type="text" id="dlAdminAccount" placeholder="Defaults to the pair account in section 1"></label>
    </div>
    <p>
      <button type="button" id="adminDlConfig">Download config.json</button>
      <button type="button" id="adminDlExe" class="ghost">Download ready build (single exe, config inbuilt)</button>
    </p>
    <p class="meta">Host and viewer downloads are gated by the admin license for the account, same as the admin build.</p>
  </div>
  <div class="card">
    <h3>Machines oversight</h3>
    <p>Machines enrolled for the account in section 1 of the MOVER tab, with their background desktop and screen view session ledgers: state, opened and ended times, who ended each session, and frames served.</p>
    <p><button type="button" id="loadAdminMachines" class="ghost">Load machines oversight</button></p>
    <div id="adminMachineList"><p class="meta">Not loaded yet.</p></div>
  </div>
  <div class="card">
    <h3>Files</h3>
    <p>Browse files on a machine for the account in section 1 of the MOVER tab. Tick the exact files to fetch, then review the list. Check this list, then confirm. Nothing moves until you confirm.</p>
    <p>Upload runs from the Viewer app only. This panel cannot upload.</p>
    <div class="row">
      <label>Machine
        <select id="filesMachine"></select>
      </label>
    </div>
    <p>
      <button type="button" id="filesLoadMachines" class="ghost">Load machines</button>
      <button type="button" id="filesBrowseBtn">Browse files</button>
    </p>
    <div id="filesTree"></div>
    <p id="filesSelTotal">Selected: 0 files, 0 B</p>
    <label>Move name <input type="text" id="filesMoveName" value=""></label>
    <p>
      <button type="button" id="filesReview">Review fetch...</button>
    </p>
    <div id="filesConfirmPanel" style="display:none">
      <p><strong>Confirm this fetch</strong></p>
      <p id="filesConfirmText"></p>
      <div id="filesConfirmList" class="meta"></div>
      <p>
        <button type="button" id="filesConfirmFetch">Confirm and fetch</button>
        <button type="button" id="filesCancelFetch" class="ghost">Back</button>
      </p>
    </div>
    <div id="filesFetchNote"></div>
    <p><strong>Transfer ledger</strong></p>
    <p>Every file a machine reports moving under a fetch or a push, newest first, across every known account.</p>
    <p><button type="button" id="filesLedgerRefresh" class="ghost">Refresh ledger</button></p>
    <div id="filesLedger"><p class="meta">Not loaded yet.</p></div>
    <p><strong>Anchor ledger</strong></p>
    <p>Every anchor deed a machine reports: a Host that updated itself, or a sibling build the anchor delivered to its suite folder. Newest first, across every known account. Updates are never automatic: each one was ordered from the MOVER tab with its exact target build named.</p>
    <p><button type="button" id="anchorLedgerRefresh" class="ghost">Refresh ledger</button></p>
    <div id="anchorLedger"><p class="meta">Not loaded yet.</p></div>
  </div>
</section>

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
      if (m.online && caps2.files) {
        var filesBtn = document.createElement("button");
        filesBtn.type = "button";
        filesBtn.className = "small";
        filesBtn.style.marginLeft = "0.5rem";
        filesBtn.textContent = "Files";
        filesBtn.addEventListener("click", function () { showFilesFor(m.machineId); });
        div.appendChild(filesBtn);
      }
      // The anchor: the row names the build the machine is
      // running and the anchor's last deed, and offers the two
      // deeds (update itself, deliver a sibling) when the
      // machine carries the anchor capability. Update is only
      // offered when this server serves a different stamp.
      var anchorBits = [];
      if (m.buildStamp) anchorBits.push("build " + m.buildStamp);
      if (m.anchorLast) {
        anchorBits.push("Anchor: " + m.anchorLast.outcome +
          (m.anchorLast.detail ? " · " + m.anchorLast.detail : ""));
      }
      if (anchorBits.length) {
        var anchorMeta = document.createElement("div");
        anchorMeta.className = "meta";
        anchorMeta.textContent = anchorBits.join(" · ");
        div.appendChild(anchorMeta);
      }
      if (m.online && caps2.anchor) {
        var served = data.buildStamp || "";
        if (served && m.buildStamp !== served) {
          var updBtn = document.createElement("button");
          updBtn.type = "button";
          updBtn.className = "small";
          updBtn.style.marginLeft = "0.5rem";
          updBtn.textContent = "Update Host to build " + served;
          updBtn.addEventListener("click", function () { askAnchorUpdate(m, served); });
          div.appendChild(updBtn);
        }
        var roleSel = document.createElement("select");
        roleSel.className = "small";
        roleSel.style.marginLeft = "0.5rem";
        ["mover", "admin", "viewer", "host"].forEach(function (roleName) {
          var opt = document.createElement("option");
          opt.value = roleName;
          opt.textContent = roleName + " build";
          roleSel.appendChild(opt);
        });
        div.appendChild(roleSel);
        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "small";
        delBtn.textContent = "Deliver sibling";
        delBtn.addEventListener("click", function () { askAnchorDeliver(m, roleSel.value, served); });
        div.appendChild(delBtn);
      }
      list.appendChild(div);
    });
  });

  // ---------------- Anchor deeds (update + deliver) ----------------
  var anchorPending = null;
  function askAnchorUpdate(m, served) {
    anchorPending = { mode: "update", machineId: m.machineId, stamp: served };
    document.getElementById("anchorPanelTitle").textContent = "Confirm Host update";
    document.getElementById("anchorText").textContent =
      "Update the Host on " + (m.name || m.machineId) + " from build " +
      (m.buildStamp || "an unstamped build") + " to build " + served + ". " +
      "The machine downloads the new build from this server, checks that its stamp is exactly " + served +
      " and that it belongs to this account, then restarts its own service onto it. " +
      "If the new build does not check in, the previous build is restored on its own. Nothing else on the machine is touched.";
    document.getElementById("anchorConfirm").textContent = "Confirm and update Host";
    document.getElementById("anchorNote").textContent = "";
    document.getElementById("anchorPanel").style.display = "block";
  }
  function askAnchorDeliver(m, role, served) {
    anchorPending = { mode: "deliver", machineId: m.machineId, role: role, stamp: served };
    document.getElementById("anchorPanelTitle").textContent = "Confirm sibling delivery";
    document.getElementById("anchorText").textContent =
      "Deliver the " + role + " build" + (served ? " " + served : "") + " to " + (m.name || m.machineId) + ". " +
      "The machine downloads it from this server, checks that it belongs to this account, and places it in its suite folder. " +
      "A host build is also planted as the machine's service, or refreshed onto it, where that applies. Nothing runs until an admin uses the delivered build.";
    document.getElementById("anchorConfirm").textContent = "Confirm and deliver";
    document.getElementById("anchorNote").textContent = "";
    document.getElementById("anchorPanel").style.display = "block";
  }
  document.getElementById("anchorCancel").addEventListener("click", function () {
    anchorPending = null;
    document.getElementById("anchorPanel").style.display = "none";
  });
  document.getElementById("anchorConfirm").addEventListener("click", async function () {
    if (!anchorPending) return;
    var pending = anchorPending;
    var action = pending.mode === "update" ? "anchor-update" : "anchor-deliver";
    var body = { accountId: accountId() };
    if (pending.mode === "update") body.stamp = pending.stamp;
    if (pending.mode === "deliver") {
      body.role = pending.role;
      if (pending.stamp) body.stamp = pending.stamp;
    }
    var res = await machineApi(pending.machineId, action, body);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      document.getElementById("anchorNote").textContent =
        "Could not queue the deed: " + (data.message || data.error || res.status);
      return;
    }
    anchorPending = null;
    document.getElementById("anchorPanel").style.display = "none";
    say((pending.mode === "update" ? "Host update" : "Sibling delivery") +
      " ordered (command " + data.commandId + "). The machine reports the outcome in its row and in the anchor ledger in the ADMIN tab.");
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
<script>
  // ---------------- Tabs, licenses, overview, moves, admin ----------------
  function esc(s) {
    return String(s == null ? "" : s)
      .split("&").join("&amp;")
      .split("<").join("&lt;")
      .split(">").join("&gt;")
      .split('"').join("&quot;");
  }
  function pill(text, cls) {
    return '<span class="pill ' + cls + '">' + esc(text) + "</span>";
  }
  function statusPill(status) {
    if (status === "active" || status === "live" || status === "sent") return pill(status, "ok");
    if (status === "revoked") return pill(status, "err");
    if (status === "ended") return pill(status, "mut");
    return pill(status, "warn");
  }
  var tabBtns = document.querySelectorAll(".tabbtn");
  tabBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      tabBtns.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      document.querySelectorAll(".tabsection").forEach(function (sec) {
        sec.classList.remove("active");
      });
      document.getElementById("tab-" + btn.getAttribute("data-tab")).classList.add("active");
      if (btn.getAttribute("data-tab") === "overview") loadOverview();
    });
  });

  // ---------------- Licenses ----------------
  async function fetchLicenses() {
    var res = await apiGet("/mover/console/api/licenses");
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
    return data.licenses || [];
  }
  function renderLicenseTable(containerId, licenses, product) {
    var el = document.getElementById(containerId);
    var rows = licenses.filter(function (lic) { return lic.product === product; });
    if (rows.length === 0) {
      el.innerHTML = '<p class="meta">No ' + esc(product) + " licenses yet. Issue the first one below.</p>";
      return;
    }
    var html = "<table><tr><th>Account</th><th>Label</th><th>Status</th><th>Issued</th><th>Note</th><th></th></tr>";
    rows.forEach(function (lic, i) {
      var btn = lic.status === "revoked"
        ? '<button type="button" class="small ghost" data-restore="' + i + '">Restore</button>'
        : '<button type="button" class="small ghost" data-revoke="' + i + '">Revoke</button>';
      html += "<tr><td><code>" + esc(lic.accountId) + "</code></td><td>" + esc(lic.label) +
        "</td><td>" + statusPill(lic.status) + "</td><td>" + esc(lic.issuedAt) +
        "</td><td>" + esc(lic.note) + "</td><td>" + btn + "</td></tr>";
    });
    html += "</table>";
    el.innerHTML = html;
    el.querySelectorAll("[data-revoke]").forEach(function (b) {
      b.addEventListener("click", function () {
        licenseChange("revoke", product, rows[Number(b.getAttribute("data-revoke"))].accountId);
      });
    });
    el.querySelectorAll("[data-restore]").forEach(function (b) {
      b.addEventListener("click", function () {
        licenseChange("restore", product, rows[Number(b.getAttribute("data-restore"))].accountId);
      });
    });
  }
  async function refreshLicenses() {
    try {
      var licenses = await fetchLicenses();
      renderLicenseTable("extLicenses", licenses, "ext");
      renderLicenseTable("moverLicenses", licenses, "mover");
      renderLicenseTable("adminLicenses", licenses, "admin");
    } catch (e) {
      say("Could not load licenses: " + e.message);
    }
  }
  async function licenseChange(action, product, acct) {
    say("");
    var res = await api("/mover/console/api/licenses/" + action, { product: product, accountId: acct });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { say("License " + action + " failed: " + (data.message || data.error || res.status)); return; }
    say("License " + (action === "revoke" ? "revoked" : "restored") + " for " + acct + " (" + product + ").");
    refreshLicenses();
    loadOverview();
  }
  function wireIssue(product, labelId, accountFieldId, noteId, issueId) {
    document.getElementById(issueId).addEventListener("click", async function () {
      say("");
      var body = {
        product: product,
        label: document.getElementById(labelId).value,
        note: document.getElementById(noteId).value
      };
      var acct = document.getElementById(accountFieldId).value.trim();
      if (acct) body.accountId = acct;
      var res = await api("/mover/console/api/licenses", body);
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) { say("Issue failed: " + (data.message || data.error || res.status)); return; }
      say("License issued for " + data.accountId + " (" + product + ").");
      document.getElementById(labelId).value = "";
      document.getElementById(accountFieldId).value = "";
      document.getElementById(noteId).value = "";
      refreshLicenses();
      loadOverview();
    });
  }
  wireIssue("ext", "extLabel", "extAccountId", "extNote", "extIssue");
  wireIssue("mover", "moverLabel", "moverAccountId", "moverNote", "moverIssue");
  wireIssue("admin", "adminLabel", "licAdminAccount", "adminNote", "adminIssue");

  // ---------------- EXT pair + config ----------------
  // The editor is prefilled from the server's own defaults (the
  // shipped pair's config), so the form can never drift from what
  // the extension supports. Messages render one input per key.
  var extDefaults = null;
  wireColor("extColorPick", "extBrandColor");
  wireColor("extSuccessBgPick", "extBrandSuccessBg");
  wireColor("extSuccessPick", "extBrandSuccess");
  function extPairAccountId() {
    var typed = document.getElementById("extPairAccountInput").value.trim();
    return typed || document.getElementById("extPairAccountId").textContent;
  }
  async function loadExtDefaults() {
    try {
      var res = await apiGet("/mover/console/api/ext/defaults");
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
      extDefaults = data.config;
      document.getElementById("extBrandName").value = extDefaults.brand.name;
      document.getElementById("extBrandTagline").value = extDefaults.brand.tagline;
      document.getElementById("extBrandBio").value = extDefaults.brand.bio;
      document.getElementById("extBrandColor").value = extDefaults.brand.primaryColor;
      document.getElementById("extColorPick").value = extDefaults.brand.primaryColor;
      document.getElementById("extBrandSuccessBg").value = extDefaults.brand.successBackground;
      document.getElementById("extSuccessBgPick").value = extDefaults.brand.successBackground;
      document.getElementById("extBrandSuccess").value = extDefaults.brand.successColor;
      document.getElementById("extSuccessPick").value = extDefaults.brand.successColor;
      document.getElementById("extShareBtnText").value = extDefaults.brand.shareButtonText;
      document.getElementById("extScanBtnText").value = extDefaults.brand.scanButtonText;
      document.getElementById("extServerUrl").value = extDefaults.server.url;
      document.getElementById("extFeatShare").checked = !!extDefaults.features.share;
      document.getElementById("extFeatServerCard").checked = !!extDefaults.features.serverCard;
      document.getElementById("extFeatLocalStorage").checked = !!extDefaults.features.localStorage;
      document.getElementById("extFeatHistory").checked = !!extDefaults.features.history;
      document.getElementById("extFeatIndexedDB").checked = !!extDefaults.features.indexedDB;
      var box = document.getElementById("extMessages");
      while (box.firstChild) box.removeChild(box.firstChild);
      Object.keys(extDefaults.messages).forEach(function (k) {
        var lab = document.createElement("label");
        lab.textContent = k + " ";
        var inp = document.createElement("input");
        inp.type = "text";
        inp.id = "extMsg_" + k;
        inp.value = extDefaults.messages[k];
        lab.appendChild(inp);
        box.appendChild(lab);
      });
    } catch (e) {
      document.getElementById("extMessages").textContent = "Could not load the defaults: " + e.message;
    }
  }
  function extOptions() {
    var messages = {};
    if (extDefaults) {
      Object.keys(extDefaults.messages).forEach(function (k) {
        var el = document.getElementById("extMsg_" + k);
        if (el) messages[k] = el.value;
      });
    }
    var acct = extPairAccountId();
    var opts = {
      role: document.getElementById("extRole").value,
      serverUrl: document.getElementById("extServerUrl").value,
      brand: {
        name: document.getElementById("extBrandName").value,
        tagline: document.getElementById("extBrandTagline").value,
        bio: document.getElementById("extBrandBio").value,
        primaryColor: document.getElementById("extBrandColor").value,
        successBackground: document.getElementById("extBrandSuccessBg").value,
        successColor: document.getElementById("extBrandSuccess").value,
        shareButtonText: document.getElementById("extShareBtnText").value,
        scanButtonText: document.getElementById("extScanBtnText").value
      },
      features: {
        share: document.getElementById("extFeatShare").checked,
        serverCard: document.getElementById("extFeatServerCard").checked,
        localStorage: document.getElementById("extFeatLocalStorage").checked,
        history: document.getElementById("extFeatHistory").checked,
        indexedDB: document.getElementById("extFeatIndexedDB").checked
      },
      messages: messages
    };
    if (acct && acct !== "(none yet)") opts.accountId = acct;
    return opts;
  }
  document.getElementById("extCreatePair").addEventListener("click", async function () {
    say("");
    var res = await api("/mover/console/api/ext/pairs");
    if (!res.ok) { say("Could not create an EXT pair (HTTP " + res.status + ")."); return; }
    var data = await res.json();
    document.getElementById("extPairAccountId").textContent = data.accountId;
    document.getElementById("extPairAccountInput").value = "";
    say("EXT pair created, and its EXT license issued. Download one side, then switch the side and download the other. Both carry this account ID.");
    refreshLicenses();
    loadOverview();
  });
  document.getElementById("extDlConfig").addEventListener("click", async function () {
    say("");
    var opts = extOptions();
    var res = await api("/mover/console/api/ext/config", opts);
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      say("EXT config failed: " + (err.message || err.error || res.status));
      return;
    }
    saveBlob(await res.blob(), "config.json");
  });
  document.getElementById("extDlZip").addEventListener("click", async function () {
    say("");
    var opts = extOptions();
    var res = await api("/mover/console/api/ext/package", opts);
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      say("EXT ready build failed: " + (err.message || err.error || res.status));
      return;
    }
    saveBlob(await res.blob(), opts.role === "admin" ? "relayn-extension-admin.zip" : "relayn-extension-child.zip");
  });
  loadExtDefaults();

  // ---------------- Overview + EXT activity ----------------
  async function loadOverview() {
    try {
      var res = await apiGet("/mover/console/api/overview");
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
      var counts = data.licenseCounts || {};
      var active = 0, revoked = 0;
      ["ext", "mover", "admin"].forEach(function (p) {
        active += (counts[p] && counts[p].active) || 0;
        revoked += (counts[p] && counts[p].revoked) || 0;
      });
      document.getElementById("ovLicActive").textContent = active;
      document.getElementById("ovLicRevoked").textContent = revoked;
      var machines = data.machines || [];
      var online = machines.filter(function (m) { return m.online; }).length;
      document.getElementById("ovMachines").textContent = online + " / " + machines.length;
      document.getElementById("ovMoves").textContent = (data.moves || []).length;
      document.getElementById("ovPayloads").textContent = (data.ext && data.ext.livePayloads) || 0;
      renderExtActivity(data.ext || {});
    } catch (e) {
      say("Could not load the overview: " + e.message);
    }
  }
  function renderExtActivity(ext) {
    var el = document.getElementById("extActivity");
    var html = "<p>Live payloads held right now: <strong>" + esc(ext.livePayloads || 0) +
      "</strong>. Encrypted backups held: <strong>" + esc(ext.backups || 0) + "</strong>.</p>";
    var shares = ext.accountShares || {};
    var accts = Object.keys(shares);
    var any = accts.some(function (a) { return (shares[a] || []).length > 0; });
    if (!any) {
      html += '<p class="meta">No live account shares right now.</p>';
    } else {
      html += "<table><tr><th>Account</th><th>Share</th><th>Cookies</th><th>Sites</th><th>Expires</th></tr>";
      accts.forEach(function (a) {
        (shares[a] || []).forEach(function (s) {
          html += "<tr><td><code>" + esc(a) + "</code></td><td><code>" + esc(s.id) +
            "</code></td><td>" + esc(s.cookieCount) + "</td><td>" + esc(s.siteCount) +
            "</td><td>" + esc(s.expiresAt) + "</td></tr>";
        });
      });
      html += "</table>";
    }
    el.innerHTML = html;
  }
  document.getElementById("refreshOverview").addEventListener("click", loadOverview);

  // ---------------- Cloud moves ----------------
  document.getElementById("loadMoves").addEventListener("click", async function () {
    say("");
    var el = document.getElementById("cloudMoves");
    try {
      var res = await apiGet("/mover/console/api/moves");
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
      var moves = data.moves || [];
      if (moves.length === 0) {
        el.innerHTML = '<p class="meta">No cloud moves held for any known account.</p>';
        return;
      }
      var html = "<table><tr><th>Name</th><th>Account</th><th>From</th><th>Size</th><th>Files</th><th>Status</th><th>Created</th></tr>";
      moves.forEach(function (mv) {
        html += "<tr><td>" + esc(mv.name || mv.moveId) + "</td><td><code>" + esc(mv.account) +
          "</code></td><td>" + esc(mv.moverName) + "</td><td>" + esc(fmtBytes(mv.totalBytes || 0)) +
          "</td><td>" + esc(mv.totalFiles || 0) + "</td><td>" + statusPill(mv.status || "") +
          "</td><td>" + esc(mv.createdAt) + "</td></tr>";
      });
      html += "</table>";
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = '<p class="meta">Could not load cloud moves: ' + esc(e.message) + "</p>";
    }
  });

  // ---------------- Admin downloads ----------------
  function adminOptions() {
    var opts = options();
    opts.role = document.getElementById("adminRole").value;
    var typed = document.getElementById("dlAdminAccount").value.trim();
    if (typed) opts.accountId = typed;
    return opts;
  }
  function adminExeName(role) {
    if (role === "host") return "relayn-host.exe";
    if (role === "viewer") return "relayn-admin-viewer.exe";
    return "relayn-mover-admin.exe";
  }
  document.getElementById("adminDlConfig").addEventListener("click", async function () {
    say("");
    var res = await api("/mover/console/api/config", adminOptions());
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      say("Config failed: " + (err.message || err.error || res.status));
      return;
    }
    saveBlob(await res.blob(), "config.json");
  });
  document.getElementById("adminDlExe").addEventListener("click", async function () {
    say("");
    var opts = adminOptions();
    var res = await api("/mover/console/api/package", opts);
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      say("Ready build failed: " + (err.message || err.error || res.status));
      return;
    }
    saveBlob(await res.blob(), adminExeName(opts.role));
  });

  // ---------------- Admin machines oversight ----------------
  function ledgerHtml(title, s) {
    if (!s) return '<div class="ledger"><strong>' + esc(title) + ':</strong> <span class="meta">no session yet</span></div>';
    var html = '<div class="ledger"><strong>' + esc(title) + ":</strong> " + statusPill(s.state || "") +
      ' <span class="meta">opened ' + esc(s.openedAt || "") + "</span>";
    if (s.endedAt) html += ' <span class="meta">ended ' + esc(s.endedAt) + "</span>";
    if (s.endedBy) html += ' <span class="meta">ended by ' + esc(s.endedBy) + "</span>";
    html += ' <span class="meta">frames served: ' + esc(s.framesServed || 0) + "</span>";
    if (s.user) html += ' <span class="meta">user: ' + esc(s.user) + "</span>";
    html += "</div>";
    return html;
  }
  document.getElementById("loadAdminMachines").addEventListener("click", async function () {
    say("");
    var el = document.getElementById("adminMachineList");
    var res = await apiGet("/mover/console/api/machines?accountId=" + encodeURIComponent(accountId()));
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { say("Could not load machines: " + (data.message || data.error || res.status)); return; }
    var machines = data.machines || [];
    if (machines.length === 0) {
      el.innerHTML = '<p class="meta">No machines enrolled for this account yet.</p>';
      return;
    }
    var html = "";
    machines.forEach(function (m, i) {
      var caps = m.capabilities && typeof m.capabilities === "object" ? m.capabilities : {};
      var capNames = Object.keys(caps).filter(function (k) { return caps[k]; });
      // Signed-in wording follows the pick: a live pick names
      // the user; an away pick (session exists, not live) says
      // so, so the row never claims a bare "signed in" for a
      // disconnected session or a bare "no one" over one.
      var signedIn = m.interactiveUser
        ? (m.interactiveAway
          ? "last seen signed in as " + m.interactiveUser + " (session away)"
          : m.interactiveUser)
        : "no one";
      // The session evidence, when the engine reported it:
      // "sessions: 2 (1 active, 1 disconnected)".
      var sessText = "";
      if (m.sessionsDiag) {
        var sd = m.sessionsDiag;
        var parts = [sd.active + " active"];
        if (sd.connected) parts.push(sd.connected + " connected");
        parts.push(sd.disconnected + " disconnected");
        if (sd.other) parts.push(sd.other + " other");
        sessText = " · sessions: " + sd.users + " (" + parts.join(", ") + ")";
      }
      html += '<div class="mrow"><div><span class="dot' + (m.online ? " on" : "") + '"></span><strong>' +
        esc(m.name || m.machineId) + "</strong> " + pill(m.online ? "online" : "offline", m.online ? "ok" : "mut") + "</div>" +
        '<div class="meta">' + esc(m.machineId) + " · state: " + esc(m.state || "idle") +
        " · signed in: " + esc(signedIn) + esc(sessText) +
        (m.runMode ? " · run mode: " + esc(m.runMode === "foreground" ? "temporary (foreground)" : m.runMode) : "") +
        (m.buildStamp ? " · build " + esc(m.buildStamp) : "") +
        " · capabilities: " + esc(capNames.length ? capNames.join(", ") : "none reported") + "</div>" +
        (m.pollOk === false
          ? '<div class="meta" style="color:var(--err)">Cannot hear orders: ' + esc(m.pollError || "the last order check failed") + "</div>"
          : "") +
        (m.anchorLast
          ? '<div class="meta">Anchor: ' + esc(m.anchorLast.outcome) +
            (m.anchorLast.detail ? " · " + esc(m.anchorLast.detail) : "") + "</div>"
          : "") +
        (m.runMode === "foreground"
          ? '<div class="meta">Temporary mode: this guard stops when its window closes. Run the Host as administrator once to plant it permanently.</div>'
          : "") +
        ledgerHtml("Background desktop", m.deskSession) +
        ledgerHtml("Screen view", m.viewSession) +
        '<div data-admin-actions="' + i + '"></div></div>';
    });
    el.innerHTML = html;
    machines.forEach(function (m, i) {
      var slot = el.querySelector('[data-admin-actions="' + i + '"]');
      var caps = m.capabilities && typeof m.capabilities === "object" ? m.capabilities : {};
      if (m.online && caps.backgroundDesktop) {
        var openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "small";
        openBtn.textContent = "Open background desktop";
        openBtn.addEventListener("click", function () {
          location.href = "/mover/console/desk/" + encodeURIComponent(m.machineId) +
            "?key=" + encodeURIComponent(key) +
            "&accountId=" + encodeURIComponent(accountId());
        });
        slot.appendChild(openBtn);
      }
      if (m.online && caps.viewScreen) {
        var viewBtn = document.createElement("button");
        viewBtn.type = "button";
        viewBtn.className = "small";
        viewBtn.style.marginLeft = "0.5rem";
        viewBtn.textContent = "View screen";
        if (!m.interactiveUser) {
          viewBtn.disabled = true;
          viewBtn.title = "No one is signed in on this machine";
          slot.appendChild(viewBtn);
          var noUser = document.createElement("span");
          noUser.className = "meta";
          noUser.textContent = " no one is signed in";
          slot.appendChild(noUser);
        } else {
          viewBtn.addEventListener("click", function () {
            location.href = "/mover/console/view/" + encodeURIComponent(m.machineId) +
              "?key=" + encodeURIComponent(key) +
              "&accountId=" + encodeURIComponent(accountId());
          });
          slot.appendChild(viewBtn);
        }
      }
      if (m.online && caps.files) {
        var filesBtn = document.createElement("button");
        filesBtn.type = "button";
        filesBtn.className = "small";
        filesBtn.style.marginLeft = "0.5rem";
        filesBtn.textContent = "Files";
        filesBtn.addEventListener("click", function () { showFilesFor(m.machineId); });
        slot.appendChild(filesBtn);
      }
    });
  });

  // ---------------- Admin Files panel ----------------
  // Browse one machine level by level through files-browse, tick
  // the exact files, review the expanded list, and only then queue
  // the signed files-fetch. Upload is Viewer-app only, so this
  // panel has no upload control at all.
  var fp = {
    machineId: "",
    machineName: "",
    ticked: {},     // path -> true
    agg: {},        // path -> {kind, count, bytes, size}
    pathsCache: {}  // prefix -> [concrete file paths]
  };
  var pendingFilesFetch = null; // {paths, count, bytes} awaiting confirmation
  var filesPreselect = "";
  function showFilesFor(machineId) {
    filesPreselect = machineId;
    var adminBtn = document.querySelector('[data-tab="admin"]');
    if (adminBtn) adminBtn.click();
    loadFilesMachines();
    loadFilesLedger();
  }
  async function loadFilesMachines() {
    var sel = document.getElementById("filesMachine");
    try {
      var res = await apiGet("/mover/console/api/machines?accountId=" + encodeURIComponent(accountId()));
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      var machines = data.machines || [];
      if (machines.length === 0) {
        var opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No machines enrolled for this account yet";
        sel.appendChild(opt);
        return;
      }
      machines.forEach(function (m) {
        var opt = document.createElement("option");
        opt.value = m.machineId;
        opt.textContent = (m.name || m.machineId) + (m.online ? "" : " (offline)");
        sel.appendChild(opt);
      });
      if (filesPreselect && machines.some(function (m) { return m.machineId === filesPreselect; })) {
        sel.value = filesPreselect;
        filesPreselect = "";
      }
    } catch (e) {
      say("Could not load machines for Files: " + e.message);
    }
  }
  document.getElementById("filesLoadMachines").addEventListener("click", loadFilesMachines);
  function filesSelPaths() {
    return Object.keys(fp.ticked).filter(function (p) { return fp.ticked[p]; });
  }
  function renderFilesSelTotal() {
    var count = 0, bytes = 0;
    filesSelPaths().forEach(function (p) {
      var a = fp.agg[p] || { kind: "file", count: 1, bytes: 0 };
      count += a.count || 0;
      bytes += a.bytes || 0;
    });
    document.getElementById("filesSelTotal").textContent =
      "Selected: " + count + " files, " + fmtBytes(bytes);
  }
  function makeFilesRow(child) {
    fp.agg[child.path] = child.kind === "folder"
      ? { kind: "folder", count: child.count || 0, bytes: child.bytes || 0 }
      : { kind: "file", count: 1, bytes: child.size || 0, size: child.size || 0 };
    var wrap = document.createElement("div");
    var row = document.createElement("div");
    row.className = "trow";
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!fp.ticked[child.path];
    box.addEventListener("change", function () {
      if (box.checked) fp.ticked[child.path] = true;
      else delete fp.ticked[child.path];
      document.getElementById("filesConfirmPanel").style.display = "none";
      pendingFilesFetch = null;
      renderFilesSelTotal();
    });
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
            await loadFilesLevel(kids, child.path, 0);
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
      : "(" + fmtBytes(child.size || 0) + (child.modTime ? ", " + child.modTime : "") + ")";
    row.appendChild(meta);
    wrap.appendChild(row);
    wrap.appendChild(kids);
    return wrap;
  }
  async function loadFilesLevel(kidsEl, prefix, offset) {
    var resp = await queueAndWait(fp.machineId, "files-browse", { prefix: prefix, offset: offset, limit: 200 });
    var children = (resp && resp.children) || [];
    if (children.length === 0 && offset === 0) {
      var empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "No files here yet.";
      kidsEl.appendChild(empty);
      return;
    }
    children.forEach(function (ch) { kidsEl.appendChild(makeFilesRow(ch)); });
    var shown = offset + children.length;
    if (resp && typeof resp.total === "number" && resp.total > shown) {
      var more = document.createElement("button");
      more.type = "button";
      more.className = "ghost small";
      more.textContent = "Show more (" + shown + " of " + resp.total + ")";
      more.addEventListener("click", async function () {
        more.remove();
        await loadFilesLevel(kidsEl, prefix, shown);
      });
      kidsEl.appendChild(more);
    }
  }
  document.getElementById("filesBrowseBtn").addEventListener("click", async function () {
    var sel = document.getElementById("filesMachine");
    if (!sel.value) { say("Load machines and pick one first."); return; }
    fp.machineId = sel.value;
    fp.machineName = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : sel.value;
    fp.ticked = {}; fp.agg = {}; fp.pathsCache = {};
    pendingFilesFetch = null;
    document.getElementById("filesConfirmPanel").style.display = "none";
    document.getElementById("filesFetchNote").textContent = "";
    var tree = document.getElementById("filesTree");
    while (tree.firstChild) tree.removeChild(tree.firstChild);
    say("Browsing files on " + fp.machineName + ". The machine answers on its next poll, this can take a few seconds.");
    try {
      await loadFilesLevel(tree, "", 0);
      document.getElementById("filesMoveName").value = "Files from " + fp.machineName;
      renderFilesSelTotal();
      say("Tick the exact files to fetch, then review the fetch.");
    } catch (e) {
      say("Browse failed: " + e.message);
    }
  });
  async function expandFilesPaths(prefix) {
    if (fp.pathsCache[prefix]) return fp.pathsCache[prefix];
    var result = await queueAndWait(fp.machineId, "paths", { prefix: prefix });
    var list = Array.isArray(result) ? result : ((result && result.paths) || []);
    fp.pathsCache[prefix] = list;
    return list;
  }
  document.getElementById("filesReview").addEventListener("click", async function () {
    if (!fp.machineId) { say("Browse a machine first."); return; }
    var ticked = filesSelPaths();
    if (ticked.length === 0) { say("Tick at least one folder or file first."); return; }
    say("Expanding the selection to the exact file list...");
    try {
      // Keep only the widest ticked paths: a ticked file inside a
      // ticked folder is already covered by the folder.
      var roots = ticked.filter(function (p) {
        return !ticked.some(function (o) { return o !== p && (p === o || p.indexOf(o + "/") === 0); });
      });
      var seen = {}, paths = [], bytes = 0;
      for (var i = 0; i < roots.length; i++) {
        var root = roots[i];
        var a = fp.agg[root] || { kind: "file", bytes: 0 };
        bytes += a.bytes || 0;
        if (a.kind === "file") {
          if (!seen[root]) { seen[root] = true; paths.push(root); }
        } else {
          var expanded = await expandFilesPaths(root);
          expanded.forEach(function (p) {
            if (!seen[p]) { seen[p] = true; paths.push(p); }
          });
        }
      }
      pendingFilesFetch = { paths: paths, count: paths.length, bytes: bytes };
      var name = document.getElementById("filesMoveName").value.trim() || ("Files from " + fp.machineName);
      document.getElementById("filesConfirmText").textContent =
        "Fetch '" + name + "' from " + fp.machineName + ": " +
        pendingFilesFetch.count + " files, " + fmtBytes(pendingFilesFetch.bytes) +
        ". Check this list, then confirm. Nothing moves until you confirm. " +
        "Confirming queues a signed files-fetch command with exactly this file list.";
      var listEl = document.getElementById("filesConfirmList");
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      paths.forEach(function (p) {
        var line = document.createElement("div");
        line.textContent = p;
        listEl.appendChild(line);
      });
      document.getElementById("filesConfirmPanel").style.display = "block";
      say("");
    } catch (e) {
      say("Could not expand the selection: " + e.message);
    }
  });
  document.getElementById("filesCancelFetch").addEventListener("click", function () {
    document.getElementById("filesConfirmPanel").style.display = "none";
    pendingFilesFetch = null;
  });
  document.getElementById("filesConfirmFetch").addEventListener("click", async function () {
    if (!pendingFilesFetch) return;
    var name = document.getElementById("filesMoveName").value.trim() || ("Files from " + fp.machineName);
    var res = await machineApi(fp.machineId, "files-fetch", {
      accountId: accountId(),
      moveName: name,
      paths: pendingFilesFetch.paths
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { say("Fetch failed: " + (data.message || data.error || res.status)); return; }
    document.getElementById("filesConfirmPanel").style.display = "none";
    var note = "Signed files-fetch command queued for " + fp.machineName +
      " (command " + data.commandId + "). Move '" + name + "' covers the " +
      pendingFilesFetch.count + " files you confirmed. " +
      "The Viewer app assembles downloads from this move; this browser never holds the account key.";
    document.getElementById("filesFetchNote").textContent = note;
    say(note);
    pendingFilesFetch = null;
    loadFilesLedger();
  });
  async function loadFilesLedger() {
    var el = document.getElementById("filesLedger");
    try {
      var res = await apiGet("/mover/console/api/files-ledger");
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
      var records = data.records || [];
      if (records.length === 0) {
        el.innerHTML = '<p class="meta">No file transfers recorded yet.</p>';
        return;
      }
      var html = "<table><tr><th>When</th><th>Machine</th><th>Direction</th><th>Path</th><th>Size</th><th>Outcome</th></tr>";
      records.forEach(function (rec) {
        html += "<tr><td>" + esc(rec.at) + "</td><td>" + esc(rec.machineId) +
          "</td><td>" + pill(rec.direction || "", rec.direction === "download" ? "ok" : "warn") +
          "</td><td>" + esc(rec.path) + "</td><td>" + esc(fmtBytes(rec.size || 0)) +
          "</td><td>" + esc(rec.outcome) + "</td></tr>";
      });
      html += "</table>";
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = '<p class="meta">Could not load the ledger: ' + esc(e.message) + "</p>";
    }
  }
  document.getElementById("filesLedgerRefresh").addEventListener("click", loadFilesLedger);
  async function loadAnchorLedger() {
    var el = document.getElementById("anchorLedger");
    try {
      var res = await apiGet("/mover/console/api/anchor-ledger");
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
      var records = data.records || [];
      if (records.length === 0) {
        el.innerHTML = '<p class="meta">No anchor deeds recorded yet.</p>';
        return;
      }
      var html = "<table><tr><th>When</th><th>Machine</th><th>Deed</th><th>Builds</th><th>Outcome</th></tr>";
      records.forEach(function (rec) {
        var builds = (rec.fromStamp || "an unstamped build") + " to " + (rec.toStamp || "");
        html += "<tr><td>" + esc(rec.at) + "</td><td>" + esc(rec.machineId) +
          "</td><td>" + esc(rec.action + (rec.role ? " (" + rec.role + ")" : "")) +
          "</td><td>" + esc(builds) +
          "</td><td>" + esc(rec.outcome) +
          (rec.detail ? '<div class="meta">' + esc(rec.detail) + "</div>" : "") + "</td></tr>";
      });
      html += "</table>";
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = '<p class="meta">Could not load the ledger: ' + esc(e.message) + "</p>";
    }
  }
  document.getElementById("anchorLedgerRefresh").addEventListener("click", loadAnchorLedger);

  refreshLicenses();
  loadOverview();
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
  options: {
    moverStore?: MoverStore;
    licenseStore?: LicenseStore;
    shareStore?: ShareStore;
    backupStore?: BackupStore;
  } = {}
): Promise<void> {
  const consoleKey = process.env.MOVER_CONSOLE_KEY ?? "";
  const pairs: ConsolePair[] = [];
  const store = options.moverStore;
  const licenseStore = options.licenseStore;
  const shareStore = options.shareStore;
  const backupStore = options.backupStore;

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
    const rawRole = body.role;
    const role: MoverRole =
      rawRole === "admin" ||
      rawRole === "host" ||
      rawRole === "viewer" ||
      rawRole === "mover"
        ? rawRole
        : "mover";
    return {
      ...(body as unknown as MoverPairOptions),
      accountId,
      role
    };
  }

  /**
   * Download gate: a revoked license for the product behind this
   * role blocks new config and ready build downloads for the
   * account. Returns true when the download may proceed.
   */
  function licenseGate(
    reply: FastifyReply,
    opts: MoverPairOptions
  ): boolean {
    if (!licenseStore) return true;
    const product = productForRole(opts.role);
    if (!licenseStore.isRevoked(product, opts.accountId)) return true;
    reply.code(403).send({
      error: "LICENSE_REVOKED",
      message:
        "This account has a revoked license for this product, so new downloads are blocked. Restore the license in the console to allow downloads again."
    });
    return false;
  }

  function needLicenseStore(
    reply: FastifyReply
  ): LicenseStore | undefined {
    if (!licenseStore) {
      reply.code(501).send({
        error: "LICENSE_STORE_NOT_CONFIGURED",
        message:
          "This server was started without the license registry, so licenses are unavailable."
      });
      return undefined;
    }
    return licenseStore;
  }

  /** Every account the console knows: license accounts plus pairs. */
  function knownAccounts(): string[] {
    const out = new Set<string>();
    if (licenseStore) {
      for (const acc of licenseStore.accounts()) out.add(acc);
    }
    for (const pair of pairs) out.add(pair.accountId);
    return [...out];
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
    // A fresh pair starts licensed for both of its products, so the
    // owner sees it in the registry and can revoke it from day one.
    if (licenseStore) {
      licenseStore.issue("mover", pair.accountId, "Console pair", "");
      licenseStore.issue("admin", pair.accountId, "Console pair", "");
    }
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
    if (!licenseGate(reply, opts)) return;
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
    if (!licenseGate(reply, opts)) return;

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
    const filename = packageFilename(opts.role);
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .send(merged);
  });

  // ----------------------------------------------------------------
  // License registry: list, issue, revoke, restore. Same console
  // gate as every other console endpoint. Revoking blocks new
  // enrollments (mover-headless.ts) and new downloads (the gate
  // above); it never ends machines or sessions already running.
  // ----------------------------------------------------------------

  app.get("/mover/console/api/licenses", async (request, reply) => {
    if (!gate(request, reply)) return;
    const ls = needLicenseStore(reply);
    if (!ls) return;
    const raw = (request.query as { product?: string } | undefined)
      ?.product;
    if (raw !== undefined && raw !== "") {
      if (!isLicenseProduct(raw)) {
        return reply.code(400).send({
          error: "INVALID_PRODUCT",
          message: "product must be one of: ext, mover, admin."
        });
      }
      return { licenses: ls.list(raw) };
    }
    return { licenses: ls.list() };
  });

  app.post("/mover/console/api/licenses", async (request, reply) => {
    if (!gate(request, reply)) return;
    const ls = needLicenseStore(reply);
    if (!ls) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!isLicenseProduct(body.product)) {
      return reply.code(400).send({
        error: "INVALID_PRODUCT",
        message: "product must be one of: ext, mover, admin."
      });
    }
    let accountId = typeof body.accountId === "string" ? body.accountId : "";
    if (accountId === "") {
      // No account named: mint a fresh one, same shape as a pair.
      accountId = `mv${randomBytes(10).toString("hex")}`;
    } else if (!ACCOUNT_ID_RE.test(accountId)) {
      return reply.code(400).send({
        error: "INVALID_ACCOUNT",
        message: "accountId must be 8-64 URL-safe characters."
      });
    }
    const lic = ls.issue(
      body.product,
      accountId,
      typeof body.label === "string" ? body.label : "",
      typeof body.note === "string" ? body.note : ""
    );
    return lic;
  });

  function licenseChange(kind: "revoke" | "restore") {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!gate(request, reply)) return;
      const ls = needLicenseStore(reply);
      if (!ls) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!isLicenseProduct(body.product)) {
        return reply.code(400).send({
          error: "INVALID_PRODUCT",
          message: "product must be one of: ext, mover, admin."
        });
      }
      const accountId =
        typeof body.accountId === "string" ? body.accountId : "";
      if (!ACCOUNT_ID_RE.test(accountId)) {
        return reply.code(400).send({
          error: "INVALID_ACCOUNT",
          message: "accountId must be 8-64 URL-safe characters."
        });
      }
      const lic =
        kind === "revoke"
          ? ls.revoke(body.product, accountId)
          : ls.restore(body.product, accountId);
      if (!lic) {
        return reply.code(404).send({
          error: "LICENSE_NOT_FOUND",
          message: "No license exists for that product and account."
        });
      }
      return lic;
    };
  }

  app.post(
    "/mover/console/api/licenses/revoke",
    licenseChange("revoke")
  );
  app.post(
    "/mover/console/api/licenses/restore",
    licenseChange("restore")
  );

  // ----------------------------------------------------------------
  // Overview + cloud moves: one read across every known account
  // (license accounts union console pairs) for the Overview, EXT
  // and MOVER tabs.
  // ----------------------------------------------------------------

  app.get("/mover/console/api/overview", async (request, reply) => {
    if (!gate(request, reply)) return;
    const accounts = knownAccounts();
    const licenses = licenseStore ? licenseStore.list() : [];
    const licenseCounts: Record<
      LicenseProduct,
      { active: number; revoked: number }
    > = {
      ext: { active: 0, revoked: 0 },
      mover: { active: 0, revoked: 0 },
      admin: { active: 0, revoked: 0 }
    };
    for (const lic of licenses) {
      licenseCounts[lic.product][lic.status] += 1;
    }
    const machines: Array<Record<string, unknown>> = [];
    const moves: Array<Record<string, unknown>> = [];
    const presence: Record<string, unknown> = {};
    if (store) {
      for (const acc of accounts) {
        for (const view of store.listHeadlessMachines(acc)) {
          machines.push({ ...view, account: acc });
        }
        presence[acc] = store.listMachines(acc);
        for (const meta of await store.listMoves(acc)) {
          moves.push({ ...meta, account: acc });
        }
      }
    }
    moves.sort((a, b) =>
      String(b.createdAt) < String(a.createdAt) ? -1 : 1
    );
    const accountShares: Record<string, unknown> = {};
    if (shareStore) {
      for (const acc of accounts) {
        accountShares[acc] = shareStore.listByAccount(acc);
      }
    }
    return {
      licenses,
      licenseCounts,
      machines,
      moves,
      presence,
      ext: {
        livePayloads: shareStore ? shareStore.size() : 0,
        accountShares,
        backups: backupStore ? backupStore.size() : 0
      }
    };
  });

  app.get("/mover/console/api/moves", async (request, reply) => {
    if (!gate(request, reply)) return;
    const st = store;
    if (!st) {
      return reply.code(501).send({
        error: "STORE_NOT_CONFIGURED",
        message:
          "This server was started without the mover store, so cloud moves are unavailable."
      });
    }
    const moves: Array<Record<string, unknown>> = [];
    for (const acc of knownAccounts()) {
      for (const meta of await st.listMoves(acc)) {
        moves.push({ ...meta, account: acc });
      }
    }
    moves.sort((a, b) =>
      String(b.createdAt) < String(a.createdAt) ? -1 : 1
    );
    return { moves };
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
    // The stamp this server currently serves rides along, so
    // the page can offer "Update Host" exactly when a machine's
    // running build differs from it ("" when no base exe is
    // configured or it carries no stamp: no offer is made).
    return {
      machines: st.listHeadlessMachines(acc),
      buildStamp: servedBuildStamp()
    };
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

  // ----------------------------------------------------------------
  // Files door operator API. Same console gate and account scoping
  // as the desk and view families. files-browse is read-only and
  // ungated, like browse and scan. files-fetch and files-push are
  // signed at queue time by the store, and queueing either is
  // license gated: a revoked license for the account answers 403
  // before anything is queued. files-fetch carries the exact
  // concrete file list the operator confirmed (the server-side
  // confirm rule: no confirmed list, no fetch).
  // ----------------------------------------------------------------

  /** True when a files queue may proceed for this account. */
  function filesLicenseGate(reply: FastifyReply, acc: string): boolean {
    if (!licenseStore) return true;
    if (!licenseStore.hasRevoked(acc)) return true;
    reply.code(403).send({
      error: "LICENSE_REVOKED",
      message:
        "This account has a revoked license, so file fetches and pushes are blocked. Restore the license in the console to allow them again."
    });
    return false;
  }

  app.post(
    "/mover/console/api/machines/:machineId/files-browse",
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
      return queueFor(reply, st, acc, params.machineId, "files-browse", payload);
    }
  );

  app.post(
    "/mover/console/api/machines/:machineId/files-fetch",
    { bodyLimit: 64 * 1024 * 1024 },
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      // The operator-verification rule, enforced server-side: a
      // fetch names the exact confirmed files. No list, no fetch.
      const paths = body.paths;
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.some((p) => typeof p !== "string" || p === "")
      ) {
        return reply.code(400).send({
          error: "EMPTY_SELECTION",
          message:
            "A fetch names the exact confirmed files: at least one file path the operator confirmed. Nothing is queued without that list."
        });
      }
      if (!filesLicenseGate(reply, acc)) return;
      const moveName =
        typeof body.moveName === "string" && body.moveName !== ""
          ? body.moveName
          : "Files fetch";
      const params = request.params as { machineId: string };
      const cmd = isValidHeadlessMachineId(params.machineId)
        ? st.queueHeadlessCommand(acc, params.machineId, "files-fetch", {
            moveName,
            paths
          })
        : undefined;
      if (!cmd) return machineNotFound(reply);
      return { commandId: cmd.id, signature: cmd.signature };
    }
  );

  app.post(
    "/mover/console/api/machines/:machineId/files-push",
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      if (
        typeof body.moveId !== "string" ||
        body.moveId === "" ||
        typeof body.destDir !== "string" ||
        body.destDir === ""
      ) {
        return reply.code(400).send({
          error: "BAD_FILES_PAYLOAD",
          message:
            "A push needs a moveId and a destDir, both as non-empty strings."
        });
      }
      if (!filesLicenseGate(reply, acc)) return;
      const params = request.params as { machineId: string };
      const cmd = isValidHeadlessMachineId(params.machineId)
        ? st.queueHeadlessCommand(acc, params.machineId, "files-push", {
            moveId: body.moveId,
            destDir: body.destDir
          })
        : undefined;
      if (!cmd) return machineNotFound(reply);
      return { commandId: cmd.id, signature: cmd.signature };
    }
  );

  app.get("/mover/console/api/files-ledger", async (request, reply) => {
    if (!gate(request, reply)) return;
    const st = needStore(reply);
    if (!st) return;
    return { records: st.listAllFilesLedger(knownAccounts()) };
  });

  // ----------------------------------------------------------------
  // Anchor operator API: the planted Host as the suite's SYSTEM
  // carrier. anchor-update orders a self-update to the EXACT
  // build stamp this server serves (the confirm-step rule,
  // enforced server-side like the start rule: a stamp that is
  // not the served stamp queues nothing). anchor-deliver orders
  // a sibling build placed in the machine's suite folder. Both
  // commands are signed at queue time by the store, both are
  // license gated like the other signed queueings, and there is
  // NO automatic path: an admin orders each deed here.
  // ----------------------------------------------------------------

  /** True when an anchor queue may proceed for this account. */
  function anchorLicenseGate(reply: FastifyReply, acc: string): boolean {
    if (!licenseStore) return true;
    if (!licenseStore.hasRevoked(acc)) return true;
    reply.code(403).send({
      error: "LICENSE_REVOKED",
      message:
        "This account has a revoked license, so anchor updates and deliveries are blocked. Restore the license in the console to allow them again."
    });
    return false;
  }

  app.post(
    "/mover/console/api/machines/:machineId/anchor-update",
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      const served = servedBuildStamp();
      const stamp = typeof body.stamp === "string" ? body.stamp : "";
      if (!served || stamp !== served) {
        return reply.code(400).send({
          error: "STAMP_MISMATCH",
          message: served
            ? `An update names the exact build this server serves (${served}); the request named "${stamp || "no stamp"}", so nothing was queued.`
            : "This server serves no stamped build (MOVER_BASE_EXE unset or unstamped), so no update can be ordered."
        });
      }
      if (!anchorLicenseGate(reply, acc)) return;
      const params = request.params as { machineId: string };
      const cmd = isValidHeadlessMachineId(params.machineId)
        ? st.queueHeadlessCommand(acc, params.machineId, "anchor-update", {
            stamp
          })
        : undefined;
      if (!cmd) return machineNotFound(reply);
      return { commandId: cmd.id, signature: cmd.signature };
    }
  );

  app.post(
    "/mover/console/api/machines/:machineId/anchor-deliver",
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const st = needStore(reply);
      if (!st) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const acc = consoleAccountId(reply, body, null);
      if (!acc) return;
      const role = body.role;
      if (
        role !== "mover" &&
        role !== "admin" &&
        role !== "viewer" &&
        role !== "host"
      ) {
        return reply.code(400).send({
          error: "BAD_ROLE",
          message:
            "A delivery names a sibling role: mover, admin, viewer or host."
        });
      }
      const served = servedBuildStamp();
      const stamp =
        typeof body.stamp === "string" && body.stamp !== ""
          ? body.stamp
          : served;
      if (stamp && served && stamp !== served) {
        return reply.code(400).send({
          error: "STAMP_MISMATCH",
          message: `A delivery names the exact build this server serves (${served}); the request named "${stamp}", so nothing was queued.`
        });
      }
      if (!anchorLicenseGate(reply, acc)) return;
      const payload: Record<string, unknown> = { role };
      if (stamp) payload.stamp = stamp;
      const params = request.params as { machineId: string };
      const cmd = isValidHeadlessMachineId(params.machineId)
        ? st.queueHeadlessCommand(acc, params.machineId, "anchor-deliver", payload)
        : undefined;
      if (!cmd) return machineNotFound(reply);
      return { commandId: cmd.id, signature: cmd.signature };
    }
  );

  app.get("/mover/console/api/anchor-ledger", async (request, reply) => {
    if (!gate(request, reply)) return;
    const st = needStore(reply);
    if (!st) return;
    return { records: st.listAllAnchorLedger(knownAccounts()) };
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
${SHARED_CSS}

  body { max-width: 1100px; margin-top: 2rem; }
  #frame { width: 100%; max-width: 100%; height: auto; display: block; border: 1px solid var(--border2); border-radius: 10px; background: #17130F; cursor: crosshair; }
  #frame:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin: 0.8rem 0; }
  #status { white-space: pre-wrap; }
  #status.err { color: var(--err); }
  .desk-diagnose {
    margin: 0.75rem 0 1rem;
    padding: 0.85rem 1rem;
    border: 1px solid var(--border2);
    border-radius: 10px;
    background: #1c1713;
    color: var(--text, #f2ebe3);
    line-height: 1.45;
  }
  .desk-diagnose h2 {
    margin: 0 0 0.55rem;
    font-size: 0.95rem;
    font-weight: 650;
    color: var(--err);
  }
  .desk-diagnose dl { margin: 0; }
  .desk-diagnose dt {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted, #a89a8c);
    margin-top: 0.45rem;
  }
  .desk-diagnose dd { margin: 0.15rem 0 0; }
  .desk-diagnose .raw {
    margin-top: 0.7rem;
    font-size: 0.78rem;
    color: var(--muted, #a89a8c);
    word-break: break-word;
  }
</style>
</head>
<body>
<h1>Background desktop</h1>
<p class="meta" id="who"></p>
<div id="status"></div>
<div id="diagnose" hidden></div>
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
  var diagnoseEl = document.getElementById("diagnose");
  var img = document.getElementById("frame");
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function clearDiagnose() {
    diagnoseEl.hidden = true;
    diagnoseEl.innerHTML = "";
    statusEl.classList.remove("err");
  }
  function say(msg) {
    clearDiagnose();
    statusEl.textContent = msg || "";
  }
  // Plain-English card for desk Create/session failures. Raw
  // error stays visible for Muse; the card names what failed,
  // what it means, and what to do next (INFERENCE until the
  // Host stage strings are measured on the machine).
  function diagnoseDeskCreateError(raw) {
    var text = String(raw || "");
    var failed = "Background desktop create failed";
    var means = "The Host refused to open the private desktop.";
    var next = "Copy the raw error below for Muse. Do not guess a fix from a truncated message.";
    var t = text.toLowerCase();
    if (t.indexOf("desk create stage birth") >= 0) {
      failed = "Host could not birth deskhost into the interactive session";
      means = "PERMANENT Backstage CreateProcessAsUser (or the pipe connect after it) failed. Without an interactive signed-in session, RelaynDesk cannot be created off the user's Default.";
      next = "Sign in on the console/RDP, ensure Host runs as LocalSystem, stamp this Host, reopen background desktop, paste the stage birth line for Muse.";
    } else if (t.indexOf("desk create stage warm-up") >= 0 ||
               t.indexOf("printwindow") >= 0) {
      failed = "Create PrintWindow warm-up failed";
      means = "Seed painted on RelaynDesk, but EnumDesktopWindows+PrintWindow composite refused or printed 0 windows. Session-0 BitBlt probes were already FALSIFIED; this Host does not fall back to BitBlt.";
      next = "Confirm deskhost is in the interactive session (stage birth passed). Paste the stage warm-up / PrintWindow line for Muse.";
    } else if (t.indexOf("desk create stage seed") >= 0 ||
               t.indexOf("could not realize its surface") >= 0) {
      failed = "Create could not seed/paint the private desktop surface";
      means = "RelaynDeskSeed RegisterClass/CreateWindow/Show/Update/FillRect failed before PrintWindow warm-up.";
      next = "Read which Win32 call is named after stage seed. Fix that call or the desktop attachment, then retry open.";
    } else if (t.indexOf("desk destroy stage switch-restore") >= 0) {
      failed = "Destroy tried a legacy input restore and was refused";
      means = "PERMANENT Create no longer claims station input. This stage only fires if a prior leave-as-input claim handle was somehow still set.";
      next = "Paste the stage line for Muse. User Default should still be theirs if Create used PrintWindow path.";
    } else if (t.indexOf("create background desktop") >= 0) {
      failed = "Host create background desktop failed";
      means = "The desk-open command returned a Host create error without a newer stage birth/seed/warm-up label.";
      next = "Stamp the Host that emits desk create stage birth|seed|warm-up, reopen background desktop, paste the new error for Muse.";
    }
    statusEl.classList.add("err");
    statusEl.textContent = "Could not open the desktop: " + text;
    diagnoseEl.hidden = false;
    diagnoseEl.innerHTML =
      '<div class="desk-diagnose">' +
        "<h2>What this Create error means</h2>" +
        "<dl>" +
          "<dt>What failed</dt><dd>" + esc(failed) + "</dd>" +
          "<dt>What this means</dt><dd>" + esc(means) + "</dd>" +
          "<dt>What to do next</dt><dd>" + esc(next) + "</dd>" +
        "</dl>" +
        '<div class="raw">Raw Host error (keep for Muse): ' + esc(text) + "</div>" +
      "</div>";
  }
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
      clearDiagnose();
      var id = await queue("desk-open", { width: 1280, height: 800, launch: ["explorer.exe"] });
      var res = await waitResult(id);
      if (res && res.error) throw new Error(res.error);
      session = res;
      say("Session live. Frames are pulled one at a time, about one a second.");
      img.focus();
      runFrames(++gen);
    } catch (e) { diagnoseDeskCreateError(e.message || String(e)); }
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
${SHARED_CSS}

  body { max-width: 1100px; margin-top: 2rem; }
  #frame { width: 100%; max-width: 100%; height: auto; display: block; border: 1px solid var(--border2); border-radius: 10px; background: #17130F; }
  .row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin: 0.8rem 0; }
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
