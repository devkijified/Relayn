// =========================================================================
// RELAYN — backup HTTP routes (Fastify plugin, TypeScript)
// -------------------------------------------------------------------------
//   POST   /api/backups      -> { id, expiresAt } (201)
//          body: { blob: { salt, iv, iterations, data }, siteDomain, cookieCount }
//          400: malformed blob / domain / size over BACKUP_MAX_BYTES (413)
//          429: rate-limited (with Retry-After)
//   GET    /api/backups/:id  -> { id, blob, siteDomain, cookieCount,
//                                 createdAt, expiresAt } (200)
//          404: unknown id — 410: expired (purged on read)
//   DELETE /api/backups/:id  -> { deleted: true } (200) / 404
//
// The server stores ciphertext only and cannot decrypt. Possession of the
// unguessable ID plus the client-side passphrase is the authorization —
// there is no approval step by design (async by nature).
//
// Wiring (index.ts):
//   import { backupRoutes } from "./backup-routes.js";
//   import { BackupStore } from "./backup-store.js";
//   const backupStore = new BackupStore();
//   await app.register(backupRoutes, { backupStore });
//   // ... in shutdown(): backupStore.shutdown();
// =========================================================================

import type { FastifyInstance } from "fastify";

import type { BackupBlob, BackupStore } from "./backup-store.js";
import { config } from "./config.js";

const RATE_LIMITS = {
    // POST /api/backups — uploads are rare and carry data
    create: { windowMs: 60 * 60 * 1000, max: 30 },
    // GET /api/backups/:id — downloads; generous, still bounded
    read: { windowMs: 60 * 1000, max: 60 }
} as const;

const MIN_PBKDF2_ITERATIONS = 50_000;
const MAX_PBKDF2_ITERATIONS = 5_000_000;
const MAX_DOMAIN_LENGTH = 253;

// -------------------------------------------------------------------------
// Sliding-window rate limiter (per key, in-memory) — same pattern as
// routes.ts, kept local so this plugin stays self-contained.
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
// Validation — the server accepts ciphertext, but still validates shape
// and size so a malformed client cannot blow up the store.
// -------------------------------------------------------------------------
function isValidBlob(input: unknown): input is BackupBlob {
    if (!input || typeof input !== "object") return false;
    const b = input as Record<string, unknown>;
    return (
        typeof b.salt === "string" && b.salt.length > 0 &&
        typeof b.iv === "string" && b.iv.length > 0 &&
        typeof b.iterations === "number" &&
        Number.isInteger(b.iterations) &&
        b.iterations >= MIN_PBKDF2_ITERATIONS &&
        b.iterations <= MAX_PBKDF2_ITERATIONS &&
        typeof b.data === "string" && b.data.length > 0 &&
        b.data.length <= config.BACKUP_MAX_BYTES
    );
}

function normalizeDomain(input: unknown): string | null {
    const raw = String(input ?? "").trim().toLowerCase().replace(/^\./, "");
    if (!raw || raw.length > MAX_DOMAIN_LENGTH) return null;
    // Hostnames only — no URLs, ports, or paths.
    if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*(\.[a-z]{2,})$/i.test(raw)) return null;
    return raw;
}

function clientIp(request: { ip: string }): string {
    return request.ip || "unknown";
}

// =========================================================================
// Plugin
// =========================================================================
export async function backupRoutes(
    app: FastifyInstance,
    options: { backupStore: BackupStore }
): Promise<void> {
    const { backupStore } = options;

    const createLimiter = createRateLimiter(RATE_LIMITS.create);
    const readLimiter = createRateLimiter(RATE_LIMITS.read);

    // ------------------------------------------------------------------
    // POST /api/backups — store an encrypted cookie backup.
    // ------------------------------------------------------------------
    app.post("/api/backups", async (request, reply) => {
        const ip = clientIp(request);
        const limit = createLimiter.check(`backup-create:${ip}`);

        if (!limit.allowed) {
            reply.header("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
            return reply.code(429).send({
                error: "RATE_LIMITED",
                message: "Too many backup uploads. Please wait and try again."
            });
        }

        const body = (request.body ?? {}) as {
            blob?: unknown;
            siteDomain?: unknown;
            cookieCount?: unknown;
        };

        if (!isValidBlob(body.blob)) {
            return reply.code(400).send({
                error: "INVALID_BLOB",
                message: "Backup blob is malformed or exceeds the size limit."
            });
        }

        const siteDomain = normalizeDomain(body.siteDomain);
        if (!siteDomain) {
            return reply.code(400).send({
                error: "INVALID_DOMAIN",
                message: "siteDomain must be a valid hostname."
            });
        }

        const cookieCount =
            typeof body.cookieCount === "number" &&
            Number.isInteger(body.cookieCount) &&
            body.cookieCount > 0 &&
            body.cookieCount <= 10000
                ? body.cookieCount
                : 0;

        if (cookieCount === 0) {
            return reply.code(400).send({
                error: "INVALID_COOKIE_COUNT",
                message: "cookieCount must be a positive integer."
            });
        }

        const record = backupStore.create(body.blob, siteDomain, cookieCount, ip);

        return reply.code(201).send({
            id: record.id,
            siteDomain: record.siteDomain,
            cookieCount: record.cookieCount,
            createdAt: record.createdAt,
            expiresAt: new Date(record.expiresAt).toISOString()
        });
    });

    // ------------------------------------------------------------------
    // GET /api/backups/:id — retrieve an encrypted backup.
    // ------------------------------------------------------------------
    app.get("/api/backups/:id", async (request, reply) => {
        const ip = clientIp(request);
        const limit = readLimiter.check(`backup-read:${ip}`);

        if (!limit.allowed) {
            reply.header("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
            return reply.code(429).send({
                error: "RATE_LIMITED",
                message: "Too many backup requests. Please wait and try again."
            });
        }

        const params = request.params as { id: string };
        const id = String(params.id || "").trim();

        // UUID v4 shape — rejects probing with junk without touching the store.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            return reply.code(404).send({
                error: "BACKUP_NOT_FOUND",
                message: "No backup matches that ID."
            });
        }

        const result = backupStore.get(id);

        if (result === undefined) {
            return reply.code(404).send({
                error: "BACKUP_NOT_FOUND",
                message: "No backup matches that ID."
            });
        }

        if (result === "expired") {
            return reply.code(410).send({
                error: "BACKUP_EXPIRED",
                message: "This backup has expired and was deleted."
            });
        }

        backupStore.recordDownload(result, ip);

        return {
            id: result.id,
            blob: result.blob,
            siteDomain: result.siteDomain,
            cookieCount: result.cookieCount,
            createdAt: result.createdAt,
            expiresAt: new Date(result.expiresAt).toISOString()
        };
    });

    // ------------------------------------------------------------------
    // DELETE /api/backups/:id — delete a backup early.
    // ------------------------------------------------------------------
    app.delete("/api/backups/:id", async (request, reply) => {
        const ip = clientIp(request);
        const params = request.params as { id: string };
        const id = String(params.id || "").trim();

        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            return reply.code(404).send({
                error: "BACKUP_NOT_FOUND",
                message: "No backup matches that ID."
            });
        }

        const deleted = backupStore.delete(id, ip);

        if (!deleted) {
            return reply.code(404).send({
                error: "BACKUP_NOT_FOUND",
                message: "No backup matches that ID."
            });
        }

        return { deleted: true, id };
    });
}
