// =========================================================================
// RELAYN — cloud share server (Fastify, TypeScript)
// -------------------------------------------------------------------------
// Pure HTTPS: no WebSocket, no sessions, no TURN. Device A uploads an
// AES-GCM encrypted cookie jar (POST /api/share) and shows a QR pickup
// ticket; Device B scans it and downloads the jar once (GET /api/share/:id).
// The server only ever holds ciphertext — the encryption key travels in
// the QR code and never touches the server.
//
// Also hosts the durable encrypted backups (POST/GET/DELETE /api/backups),
// where the backup ID + passphrase is the authorization.
//
//   pnpm dev    — local development (tsx, watches src)
//   pnpm build  — tsc -> dist/
//   pnpm start  — node dist/index.js (what Docker / Render run)
// =========================================================================

// Load .env (PORT, TRUST_PROXY, ...) before config.ts reads process.env.
// No-op if the file is absent — hosts like Render inject env vars directly.
import "dotenv/config";

import Fastify from "fastify";
import cors from "@fastify/cors";

import { backupRoutes } from "./backup-routes.js";
import { BackupStore } from "./backup-store.js";
import { config } from "./config.js";
import { shareRoutes } from "./share-routes.js";
import { ShareStore } from "./share-store.js";

const app = Fastify({
  logger: true,
  // Share uploads carry megabytes of encrypted cookies — the 1 MB
  // default would reject them with 413 before our own size check runs.
  bodyLimit: config.SHARE_MAX_BYTES + 64 * 1024,
  // Honor X-Forwarded-For from the reverse proxy (Render, Railway,
  // Fly.io, nginx, ...) so request.ip — used by the rate limiter — is
  // the real client IP. Leave TRUST_PROXY=false when exposed directly.
  trustProxy: config.TRUST_PROXY
});

const shareStore = new ShareStore();
const backupStore = new BackupStore();

/*
 * CORS policy: empty CORS_ORIGIN disables CORS. "*" is development-only.
 * A comma-separated list sets specific allowed origins.
 */
function parseCorsOrigin(raw: string): boolean | string | string[] {
  const value = raw.trim();
  if (value === "") return false;
  if (value === "*") return true;
  const list = value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return list.length === 1 ? list[0] : list;
}

await app.register(cors, {
  origin: parseCorsOrigin(config.CORS_ORIGIN)
});

// Ephemeral device-to-device shares (ciphertext only, single-use).
await app.register(shareRoutes, { shareStore });

// Durable encrypted cookie backups (ciphertext only, ID + passphrase auth).
// In-memory: restarting the server deletes all backups.
await app.register(backupRoutes, { backupStore });

app.get("/", async () => {
  return {
    name: "Relayn Server",
    version: "0.2.0",
    status: "online"
  };
});

app.get("/health", async () => {
  return {
    status: "ok",
    service: "relayn-server",
    timestamp: new Date().toISOString()
  };
});

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received. Shutting down Relayn Server.`);
  shareStore.shutdown();
  backupStore.shutdown();
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await app.listen({
    host: config.HOST,
    port: config.PORT
  });
  app.log.info(`Relayn Server listening on ${config.HOST}:${config.PORT}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
