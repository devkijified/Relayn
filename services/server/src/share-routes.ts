// =========================================================================
// RELAYN — ephemeral share HTTP routes (Fastify plugin, TypeScript)
// -------------------------------------------------------------------------
//   POST   /api/share      -> { id, expiresAt } (201)
//          body: { blob: { iv, data }, cookieCount, siteCount }
//          400: malformed blob / counts — 413: over SHARE_MAX_BYTES
//          429: rate-limited (with Retry-After)
//   GET    /api/share/:id  -> { id, blob, cookieCount, siteCount,
//                               createdAt, expiresAt } (200, SINGLE-USE)
//          404: unknown id or already consumed — 410: expired
//
// The server stores ciphertext only and cannot decrypt it: the AES-GCM key
// lives in the QR code on Device A's screen, scanned by Device B's camera.
// Possession of the unguessable 128-bit share ID IS the authorization —
// there is no account, approval step, or second factor by design.
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
  read: { windowMs: 60 * 1000, max: 60 }
} as const;

const SHARE_ID_RE = /^[0-9a-f]{32}$/;

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
// not inspect the encrypted contents.
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

  // ------------------------------------------------------------------
  // POST /api/share — Device A uploads its encrypted cookie jar.
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

    const record = shareStore.create(
      body.blob,
      body.cookieCount as number,
      body.siteCount as number
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
  // GET /api/share/:id — Device B picks up the share (single-use).
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
}
