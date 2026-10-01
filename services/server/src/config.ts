import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),

  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(4000),

  /*
   * CORS policy. Empty (the default) disables CORS entirely — the Chrome
   * extension calls this API with fetch() from a privileged context and
   * does not need CORS. Set to "*" only for local development, or to a
   * comma-separated list of origins.
   */
  CORS_ORIGIN: z.string().default(""),

  /*
   * Set TRUST_PROXY=true when running behind a reverse proxy (Render,
   * Railway, Fly.io, nginx, ...) so request.ip — used by the rate
   * limiter — is the real client IP, not the proxy's.
   */
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),

  /*
   * Ephemeral device-to-device share. Device A uploads an AES-GCM
   * encrypted cookie jar; Device B downloads it once using the pickup
   * ticket from the QR code. The server only ever holds ciphertext —
   * the encryption key travels in the QR code and never touches the
   * server. Single-use (deleted on first download) with a short TTL.
   */
  SHARE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),

  /*
   * Max accepted share upload body. A few thousand cookies encrypt to
   * roughly 1–3 MB of base64; 8 MB leaves comfortable headroom.
   */
  SHARE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),

  /*
   * Durable encrypted cookie backups (POST /api/backups). The server
   * stores ciphertext only — the passphrase never leaves the browser.
   * BACKUP_TTL_MS default 7 days; a restart wipes the in-memory store.
   */
  BACKUP_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60 * 1000),

  BACKUP_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024)
});

export const config = envSchema.parse({
  HOST: process.env.HOST,
  PORT: process.env.PORT,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  TRUST_PROXY: process.env.TRUST_PROXY,
  SHARE_TTL_MS: process.env.SHARE_TTL_MS,
  SHARE_MAX_BYTES: process.env.SHARE_MAX_BYTES,
  BACKUP_TTL_MS: process.env.BACKUP_TTL_MS,
  BACKUP_MAX_BYTES: process.env.BACKUP_MAX_BYTES
});
