import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),

  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(4000),

  CORS_ORIGIN: z.string().default("*"),

  SESSION_CODE_LENGTH: z.coerce
    .number()
    .int()
    .min(4)
    .max(10)
    .default(6),

  SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),

  END_SESSION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(90 * 1000),

  HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 1000)
});

export const config = envSchema.parse({
  HOST: process.env.HOST,
  PORT: process.env.PORT,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  SESSION_CODE_LENGTH: process.env.SESSION_CODE_LENGTH,
  SESSION_TTL_MS: process.env.SESSION_TTL_MS,
  END_SESSION_TIMEOUT_MS: process.env.END_SESSION_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS: process.env.HEARTBEAT_INTERVAL_MS
});
