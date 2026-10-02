// =========================================================================
// RELAYN — share HTTP routes (Fastify plugin, TypeScript)
// -------------------------------------------------------------------------
//   POST   /api/share                     -> { id, expiresAt } (201)
//          body: { blob: { iv, data }, cookieCount, siteCount,
//                  accountId?, key? }
//          400: malformed blob / counts / accountId / key
//          413: over SHARE_MAX_BYTES — 429: rate-limited
//
//   GET    /api/share/:id                 -> share (200)
//          Anonymous: SINGLE-USE (deleted on first read).
//          Account: multi-use within its 48h TTL.
//          404: unknown id — 410: expired
//
//   GET    /api/account/:accountId/shares -> { shares: [...] } (200)
//          Metadata list (no blobs, no keys) of one account's live shares.
//          400: malformed accountId
//
//   GET    /api/account/:accountId/shares/:shareId -> full share (200)
//          { id, blob, key, cookieCount, siteCount, createdAt, expiresAt }
//          One-tap retrieval for the admin build. The key is returned on
//          purpose here: account shares deliberately store the full QR
//          (ciphertext + key) under the pre-shared account ID — product
//          decision, see share-store.ts. Possession of the account ID IS
//          the authorization, same model as the backup ID + passphrase.
//          400: malformed accountId — 404: unknown — 410: expired
//
// Wiring (index.ts):
//   import { shareRoutes } from "./share-routes.js";
//   import { ShareStore } from "./share-store.js";
//   const shareStore = new ShareStore();
//   await app.register(shareRoutes, { shareStore });
//   // ... in shutdown(): shareStore.shutdown();
// =========================================================================

import type { FastifyInstance } from "fastify";

import type { ShareBlob, ShareStore } from "./share-store.js";
import { config } from "./config.js";

const RATE_LIMITS = {
  // POST /api/share — uploads are rare and carry data
  create: { windowMs: 60 * 60 * 1000, max: 20 },
  // GET /api/share/:id — pickup downloads; generous, still bounded
  read: { windowMs: 60 * 1000, max: 60 },
  // GET /api/account/... — inbox polling; generous, still bounded
  accountRead: { windowMs: 60 * 1000, max: 120 }
} as const;

const SHARE_ID_RE = /^[0-9a-f]{32}$/;
// Pre-shared account ID both builds carry in config.json: unguessable,
// URL-safe, 8–64 chars.
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// -------------------------------------------------------------------------
// Sliding-window rate limiter (per key, in-memory).
// -------------------------------------------------------------------------
function createRateLimiter(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();

  function check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const cutoff = now - opts.windowMs;

    let entries = hits.get(key);
    if (!entries) {
      entries = [];
      hits.set(key, entries);
    }

    while (entries.length > 0 && entries[0] <= cutoff) {
      entries.shift();
    }

    if (entries.length >= opts.max) {
      return {
        allowed: false,
        retryAfterMs: entries[0] + opts.windowMs - now
      };
    }

    entries.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  const pruneTimer: ReturnType<typeof setInterval> = setInterval(() => {
    const cutoff = Date.now() - opts.windowMs;
    for (const [key, entries] of hits) {
      while (entries.length > 0 && entries[0] <= cutoff) {
        entries.shift();
      }
      if (entries.length === 0) {
        hits.delete(key);
      }
    }
  }, opts.windowMs);
  // unref is Node-only; the DOM lib types setInterval as number.
  const maybeTimer = pruneTimer as unknown as { unref?: () => void };
  if (typeof maybeTimer.unref === "function") maybeTimer.unref();

  return { check };
}

// -------------------------------------------------------------------------
// Validation — ciphertext shape and size only; the server cannot and must
// not inspect the encrypted contents. (Account shares intentionally also
// carry the key — see the header note.)
// -------------------------------------------------------------------------
function isBase64(input: unknown): input is string {
  if (typeof input !== "string" || input.length === 0) return false;
  // Length cap first so a hostile client cannot blow up the regex engine.
  if (input.length > config.SHARE_MAX_BYTES) return false;
  return /^[A-Za-z0-9+/=]+$/.test(input);
}

function isValidBlob(input: unknown): input is ShareBlob {
  if (!input || typeof input !== "object") return false;
  const b = input as Record<string, unknown>;
  return (
    isBase64(b.iv) &&
    (b.iv as string).length <= 32 && // 12-byte IV -> 16 base64 chars
    isBase64(b.data) &&
    (b.data as string).length <= config.SHARE_MAX_BYTES
  );
}

function validCount(input: unknown): boolean {
  return (
    typeof input === "number" &&
    Number.isInteger(input) &&
    input > 0 &&
    input <= 100_000
  );
}

function validAccountId(input: unknown): input is string {
  return typeof input === "string" && ACCOUNT_ID_RE.test(input);
}

// Base64 of a 256-bit AES key: exactly 32 bytes when decoded.
function validShareKey(input: unknown): input is string {
  if (typeof input !== "string" || !/^[A-Za-z0-9+/=]+$/.test(input)) return false;
  try {
    return Buffer.from(input, "base64").length === 32;
  } catch {
    return false;
  }
}

function clientIp(request: { ip: string }): string {
  return request.ip || "unknown";
}

// =========================================================================
// Plugin
// =========================================================================
export async function shareRoutes(
  app: FastifyInstance,
  options: { shareStore: ShareStore }
): Promise<void> {
  const { shareStore } = options;

  const createLimiter = createRateLimiter(RATE_LIMITS.create);
  const readLimiter = createRateLimiter(RATE_LIMITS.read);
  const accountLimiter = createRateLimiter(RATE_LIMITS.accountRead);

  function accountReadAllowed(request: { ip: string }, reply: any): boolean {
    const limit = accountLimiter.check(`share-account:${clientIp(request)}`);
    if (!limit.allowed) {
      reply.header("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
      reply.code(429).send({
        error: "RATE_LIMITED",
        message: "Too many requests. Please wait and try again."
      });
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------
  // POST /api/share — Device A uploads its encrypted cookie jar.
  // With accountId (+ key): stored under the assigned account, 48h TTL,
  // multi-use. Without: anonymous single-use share, 10-minute TTL.
  // ------------------------------------------------------------------
  app.post("/api/share", async (request, reply) => {
    const ip = clientIp(request);
    const limit = createLimiter.check(`share-create:${ip}`);

    if (!limit.allowed) {
      reply.header("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
      return reply.code(429).send({
        error: "RATE_LIMITED",
        message: "Too many share uploads. Please wait and try again."
      });
    }

    const body = (request.body ?? {}) as {
      blob?: unknown;
      cookieCount?: unknown;
      siteCount?: unknown;
      accountId?: unknown;
      key?: unknown;
    };

    if (!isValidBlob(body.blob)) {
      return reply.code(400).send({
        error: "INVALID_BLOB",
        message: "Share blob is malformed or exceeds the size limit."
      });
    }

    if (!validCount(body.cookieCount) || !validCount(body.siteCount)) {
      return reply.code(400).send({
        error: "INVALID_COUNTS",
        message: "cookieCount and siteCount must be positive integers."
      });
    }

    // Account binding is all-or-nothing: an accountId without its key
    // (or a key without an account) is a malformed request.
    const hasAccount = body.accountId !== undefined && body.accountId !== null && body.accountId !== "";
    const hasKey = body.key !== undefined && body.key !== null && body.key !== "";
    let accountId: string | undefined;
    let keyB64: string | undefined;
    if (hasAccount || hasKey) {
      if (!hasAccount || !validAccountId(body.accountId)) {
        return reply.code(400).send({
          error: "INVALID_ACCOUNT",
          message: "accountId must be 8–64 URL-safe characters."
        });
      }
      if (!hasKey || !validShareKey(body.key)) {
        return reply.code(400).send({
          error: "INVALID_KEY",
          message: "Account shares must include the base64 AES key."
        });
      }
      accountId = body.accountId as string;
      keyB64 = body.key as string;
    }

    const record = shareStore.create(
      body.blob,
      body.cookieCount as number,
      body.siteCount as number,
      accountId ? { accountId, keyB64 } : undefined
    );

    return reply.code(201).send({
      id: record.id,
      cookieCount: record.cookieCount,
      siteCount: record.siteCount,
      createdAt: record.createdAt,
      expiresAt: new Date(record.expiresAt).toISOString()
    });
  });

  // ------------------------------------------------------------------
  // GET /api/share/:id — pickup download.
  // Anonymous: single-use. Account: multi-use within its TTL.
  // ------------------------------------------------------------------
  app.get("/api/share/:id", async (request, reply) => {
    const ip = clientIp(request);
    const limit = readLimiter.check(`share-read:${ip}`);

    if (!limit.allowed) {
      reply.header("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
      return reply.code(429).send({
        error: "RATE_LIMITED",
        message: "Too many share requests. Please wait and try again."
      });
    }

    const params = request.params as { id: string };
    const id = String(params.id || "").trim().toLowerCase();

    // Fixed 128-bit hex shape — rejects probing with junk without
    // touching the store.
    if (!SHARE_ID_RE.test(id)) {
      return reply.code(404).send({
        error: "SHARE_NOT_FOUND",
        message: "No share matches that code."
      });
    }

    const result = shareStore.consume(id);

    if (result === undefined) {
      return reply.code(404).send({
        error: "SHARE_NOT_FOUND",
        message:
          "No share matches that code. It may already have been used."
      });
    }

    if (result === "expired") {
      return reply.code(410).send({
        error: "SHARE_EXPIRED",
        message: "This share code has expired. Ask Device A to share again."
      });
    }

    return {
      id: result.id,
      blob: result.blob,
      cookieCount: result.cookieCount,
      siteCount: result.siteCount,
      createdAt: result.createdAt,
      expiresAt: new Date(result.expiresAt).toISOString()
    };
  });

  // ------------------------------------------------------------------
  // GET /api/account/:accountId/shares — metadata list for the inbox.
  // ------------------------------------------------------------------
  app.get("/api/account/:accountId/shares", async (request, reply) => {
    if (!accountReadAllowed(request, reply)) return;

    const params = request.params as { accountId: string };
    const accountId = String(params.accountId || "").trim();
    if (!validAccountId(accountId)) {
      return reply.code(400).send({
        error: "INVALID_ACCOUNT",
        message: "accountId must be 8–64 URL-safe characters."
      });
    }

    return { shares: shareStore.listByAccount(accountId) };
  });

  // ------------------------------------------------------------------
  // GET /api/account/:accountId/shares/:shareId — full share + key.
  // ------------------------------------------------------------------
  app.get("/api/account/:accountId/shares/:shareId", async (request, reply) => {
    if (!accountReadAllowed(request, reply)) return;

    const params = request.params as { accountId: string; shareId: string };
    const accountId = String(params.accountId || "").trim();
    const shareId = String(params.shareId || "").trim().toLowerCase();

    if (!validAccountId(accountId)) {
      return reply.code(400).send({
        error: "INVALID_ACCOUNT",
        message: "accountId must be 8–64 URL-safe characters."
      });
    }
    if (!SHARE_ID_RE.test(shareId)) {
      return reply.code(404).send({
        error: "SHARE_NOT_FOUND",
        message: "No share matches that code."
      });
    }

    const result = shareStore.getAccountShare(accountId, shareId);
    if (result === undefined) {
      return reply.code(404).send({
        error: "SHARE_NOT_FOUND",
        message: "No share matches that code."
      });
    }
    if (result === "expired") {
      return reply.code(410).send({
        error: "SHARE_EXPIRED",
        message: "This share has expired."
      });
    }

    return {
      id: result.id,
      blob: result.blob,
      key: result.keyB64,
      cookieCount: result.cookieCount,
      siteCount: result.siteCount,
      createdAt: result.createdAt,
      expiresAt: new Date(result.expiresAt).toISOString()
    };
  });
}
