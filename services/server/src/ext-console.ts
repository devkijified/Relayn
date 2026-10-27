// =========================================================================
// RELAYN EXT — console pair flow for the browser extension.
//
// Mirrors the Mover pair flow in mover-console.ts, for the extension:
//
//   GET  /mover/console/api/ext/defaults   the default EXT config.json
//   POST /mover/console/api/ext/pairs      create an EXT pair account
//   POST /mover/console/api/ext/config     download a merged config.json
//   POST /mover/console/api/ext/package    download a ready build (zip):
//                                          the staged extension files
//                                          with config.json replaced
//                                          by the merged config
//
// The pair is two builds of the same staged files whose config.json
// differs exactly the way the shipped pair differs (verified against
// relayn-extension-admin-latest.zip and relayn-extension-child-latest
// .zip: identical bytes except config.json): the CHILD is share-only
// (features.share on, scan and inbox off); the ADMIN adds scan and
// inbox. The account link is config.account.id, the same id on both
// sides. An empty account id is the extension's anonymous mode.
//
// Every configurable the extension actually supports is editable:
// the full set is the one background.js defines (DEFAULT_BRAND plus
// applyBrandConfig): brand (8 fields), server.url, features (7
// booleans; share, serverCard, localStorage, history, indexedDB are
// free, scan and inbox are set by the side), account.id, and every
// message string (63 keys). validateExtConfig mirrors the extension's
// own acceptance rules (length caps, hex colours, the server URL
// shape, the account ID shape) in the mover form's style: invalid
// input is rejected with the list of problems, never silently sliced.
//
// Gating: the same console key as the rest of the console (404 when
// unset or wrong). License gating matches the mover downloads: when
// the license registry is present, a download for an account whose
// EXT license is revoked answers 403 LICENSE_REVOKED. Creating a
// pair issues the new account's EXT license (label "Console EXT
// pair"). The staged extension files live in assets/ext (env
// EXT_ASSETS_DIR overrides), the way MOVER_BASE_EXE stages the mover
// base; when they are missing the package download answers a clear
// 501 and the config download keeps working.
// =========================================================================

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { EXT_DEFAULT_CONFIG, type ExtRole } from "./ext-defaults.js";
import type { LicenseStore } from "./license-store.js";
import { buildZip, type ZipEntry } from "./zip.js";

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// The extension's own server URL rule (applyBrandConfig): http(s),
// a host, and no path beyond an optional trailing slash.
const EXT_SERVER_URL_RE = /^https?:\/\/[^/\s]+\/?$/;

export interface ExtPairOptions {
  accountId?: string;
  role?: ExtRole;
  serverUrl?: string;
  brand?: {
    name?: string;
    tagline?: string;
    bio?: string;
    primaryColor?: string;
    successBackground?: string;
    successColor?: string;
    shareButtonText?: string;
    scanButtonText?: string;
  };
  features?: {
    share?: boolean;
    serverCard?: boolean;
    localStorage?: boolean;
    history?: boolean;
    indexedDB?: boolean;
  };
  messages?: Record<string, string>;
}

type ExtConfig = typeof EXT_DEFAULT_CONFIG;

function cloneDefaults(): ExtConfig {
  return JSON.parse(JSON.stringify(EXT_DEFAULT_CONFIG)) as ExtConfig;
}

function strOr(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function boolOr(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Build the complete config.json for one side of an EXT pair.
 * Defaults are the shipped pair's config; the side forces scan and
 * inbox (child: both off, admin: both on), exactly as the shipped
 * pair differs. Everything else comes from the options.
 */
export function buildExtConfig(opts: ExtPairOptions) {
  const cfg = cloneDefaults();
  const role: ExtRole = opts.role === "admin" ? "admin" : "child";
  const brand = opts.brand ?? {};
  const features = opts.features ?? {};

  cfg.brand.name = strOr(brand.name, cfg.brand.name);
  cfg.brand.tagline = strOr(brand.tagline, cfg.brand.tagline);
  cfg.brand.bio = strOr(brand.bio, cfg.brand.bio);
  cfg.brand.primaryColor = strOr(brand.primaryColor, cfg.brand.primaryColor);
  cfg.brand.successBackground = strOr(
    brand.successBackground,
    cfg.brand.successBackground
  );
  cfg.brand.successColor = strOr(brand.successColor, cfg.brand.successColor);
  cfg.brand.shareButtonText = strOr(
    brand.shareButtonText,
    cfg.brand.shareButtonText
  );
  cfg.brand.scanButtonText = strOr(
    brand.scanButtonText,
    cfg.brand.scanButtonText
  );

  if (typeof opts.serverUrl === "string" && opts.serverUrl !== "") {
    cfg.server.url = opts.serverUrl.replace(/\/+$/, "");
  }

  cfg.features.share = boolOr(features.share, cfg.features.share);
  cfg.features.serverCard = boolOr(features.serverCard, cfg.features.serverCard);
  cfg.features.localStorage = boolOr(
    features.localStorage,
    cfg.features.localStorage
  );
  cfg.features.history = boolOr(features.history, cfg.features.history);
  cfg.features.indexedDB = boolOr(features.indexedDB, cfg.features.indexedDB);
  // The pair definition: the child is share-only, the admin adds
  // scan and inbox. These two are set by the side, never by the form.
  cfg.features.scan = role === "admin";
  cfg.features.inbox = role === "admin";

  cfg.account.id =
    typeof opts.accountId === "string" ? opts.accountId.trim() : "";

  if (opts.messages && typeof opts.messages === "object") {
    for (const [key, value] of Object.entries(opts.messages)) {
      if (typeof value === "string" && value !== "") {
        (cfg.messages as Record<string, string>)[key] = value;
      }
    }
  }
  return cfg;
}

/**
 * The extension's own acceptance rules (applyBrandConfig in
 * background.js), enforced in the mover form's style: a config that
 * the extension would silently ignore or fall back on is rejected
 * here with the problems listed instead.
 */
export function validateExtConfig(cfg: unknown): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const c = (cfg ?? {}) as Record<string, any>;
  const brand = (c.brand ?? {}) as Record<string, unknown>;
  const caps: Record<string, number> = {
    name: 60,
    tagline: 120,
    bio: 300,
    shareButtonText: 80,
    scanButtonText: 80
  };
  for (const [key, cap] of Object.entries(caps)) {
    const v = brand[key];
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`brand.${key} must be a non-empty string`);
    } else if (v.length > cap) {
      errors.push(`brand.${key} must be at most ${cap} characters`);
    }
  }
  for (const key of ["primaryColor", "successBackground", "successColor"]) {
    if (!HEX_COLOR_RE.test(String(brand[key] ?? ""))) {
      errors.push(`brand.${key} must be a #RGB or #RRGGBB hex color`);
    }
  }
  const url = String(c.server?.url ?? "");
  if (!EXT_SERVER_URL_RE.test(url)) {
    errors.push(
      "server.url must be an http(s) address with a host and no path, the shape the extension accepts"
    );
  }
  for (const key of [
    "share",
    "scan",
    "serverCard",
    "inbox",
    "localStorage",
    "history",
    "indexedDB"
  ]) {
    if (typeof c.features?.[key] !== "boolean") {
      errors.push(`features.${key} must be boolean`);
    }
  }
  const accountId = String(c.account?.id ?? "");
  if (accountId !== "" && !ACCOUNT_ID_RE.test(accountId)) {
    errors.push("account.id must be empty or 8-64 URL-safe characters");
  }
  const defaults = EXT_DEFAULT_CONFIG.messages as Record<string, string>;
  const messages = (c.messages ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(messages)) {
    if (!(key in defaults)) {
      errors.push(`messages.${key} is not a message the extension supports`);
    } else if (typeof value !== "string" || value === "") {
      errors.push(`messages.${key} must be a non-empty string`);
    } else if (value.length > 500) {
      errors.push(`messages.${key} must be at most 500 characters`);
    }
  }
  for (const key of Object.keys(defaults)) {
    if (!(key in messages)) errors.push(`messages.${key} is missing`);
  }
  return { ok: errors.length === 0, errors };
}

// -------------------------------------------------------------------------
// Staged extension files. The package download is these files with
// config.json replaced by the merged config, in the same root layout
// as the shipped pair zips.
// -------------------------------------------------------------------------

export const EXT_PACKAGE_FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
  "README.md",
  "qrcode.min.js",
  "jsQR.min.js"
] as const;

function extAssetsDir(): string {
  const fromEnv = process.env.EXT_ASSETS_DIR ?? "";
  if (fromEnv !== "") return fromEnv;
  // src/ in dev (tsx) and dist/ in production both sit one level
  // below the server root, so ../assets/ext resolves the same way.
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "assets",
    "ext"
  );
}

async function readExtAssets(): Promise<ZipEntry[] | undefined> {
  const dir = extAssetsDir();
  const entries: ZipEntry[] = [];
  try {
    for (const name of EXT_PACKAGE_FILES) {
      entries.push({ name, data: await fs.readFile(path.join(dir, name)) });
    }
  } catch {
    return undefined;
  }
  return entries;
}

// -------------------------------------------------------------------------
// Plugin. Its own gate hook, scoped to this plugin's routes, with the
// same rule as the rest of the console: no key configured or a wrong
// key means these routes do not exist (404).
// -------------------------------------------------------------------------

export async function extConsoleRoutes(
  app: FastifyInstance,
  options: { licenseStore?: LicenseStore } = {}
): Promise<void> {
  const consoleKey = process.env.MOVER_CONSOLE_KEY ?? "";
  const licenseStore = options.licenseStore;
  const pairs: { accountId: string; createdAt: string }[] = [];

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

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/mover/console/api/ext")) return;
    gate(request, reply);
  });

  function parseOptions(
    request: FastifyRequest,
    reply: FastifyReply
  ): ExtPairOptions | undefined {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const accountId = String(body.accountId ?? "").trim();
    if (accountId !== "" && !ACCOUNT_ID_RE.test(accountId)) {
      reply.code(400).send({
        error: "INVALID_ACCOUNT",
        message: "accountId must be empty or 8-64 URL-safe characters."
      });
      return undefined;
    }
    if (
      body.messages !== undefined &&
      (typeof body.messages !== "object" || body.messages === null)
    ) {
      reply.code(400).send({
        error: "INVALID_MESSAGES",
        message: "messages must be an object of message overrides."
      });
      return undefined;
    }
    return {
      ...(body as unknown as ExtPairOptions),
      accountId,
      role: body.role === "admin" ? "admin" : "child"
    };
  }

  function licenseGate(
    reply: FastifyReply,
    opts: ExtPairOptions
  ): boolean {
    const accountId = opts.accountId ?? "";
    if (
      accountId !== "" &&
      licenseStore &&
      licenseStore.isRevoked("ext", accountId)
    ) {
      reply.code(403).send({
        error: "LICENSE_REVOKED",
        message:
          "The EXT license for this account is revoked, so new downloads are blocked. Restore the license on the EXT tab to download again."
      });
      return false;
    }
    return true;
  }

  function buildChecked(
    reply: FastifyReply,
    opts: ExtPairOptions
  ): ReturnType<typeof buildExtConfig> | undefined {
    const cfg = buildExtConfig(opts);
    const check = validateExtConfig(cfg);
    if (!check.ok) {
      reply.code(400).send({
        error: "INVALID_CONFIG",
        message: check.errors.join("; ")
      });
      return undefined;
    }
    return cfg;
  }

  app.get("/mover/console/api/ext/defaults", async (request, reply) => {
    if (!gate(request, reply)) return;
    return { config: cloneDefaults() };
  });

  app.post("/mover/console/api/ext/pairs", async (request, reply) => {
    if (!gate(request, reply)) return;
    // Same account shape as the mover pairs: mv + 20 hex.
    const pair = {
      accountId: `mv${randomBytes(10).toString("hex")}`,
      createdAt: new Date().toISOString()
    };
    pairs.push(pair);
    licenseStore?.issue("ext", pair.accountId, "Console EXT pair", "");
    return pair;
  });

  app.post("/mover/console/api/ext/config", async (request, reply) => {
    if (!gate(request, reply)) return;
    const opts = parseOptions(request, reply);
    if (!opts) return;
    if (!licenseGate(reply, opts)) return;
    const cfg = buildChecked(reply, opts);
    if (!cfg) return;
    return reply
      .header("content-type", "application/json")
      .header("content-disposition", 'attachment; filename="config.json"')
      .send(JSON.stringify(cfg, null, 1));
  });

  app.post("/mover/console/api/ext/package", async (request, reply) => {
    if (!gate(request, reply)) return;
    const opts = parseOptions(request, reply);
    if (!opts) return;
    if (!licenseGate(reply, opts)) return;
    const cfg = buildChecked(reply, opts);
    if (!cfg) return;

    const assets = await readExtAssets();
    if (!assets) {
      return reply.code(501).send({
        error: "EXT_ASSETS_NOT_CONFIGURED",
        message:
          "The extension files are not staged on this server (assets/ext), so ready builds are unavailable. The config.json download still works."
      });
    }
    const entries: ZipEntry[] = [
      { name: "config.json", data: Buffer.from(JSON.stringify(cfg, null, 1), "utf8") },
      ...assets
    ];
    const zip = buildZip(entries);
    const filename =
      opts.role === "admin"
        ? "relayn-extension-admin.zip"
        : "relayn-extension-child.zip";
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .send(zip);
  });
}
