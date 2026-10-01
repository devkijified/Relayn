// =========================================================================
// RELAYN — ephemeral device-to-device share store (in-memory, TypeScript)
// -------------------------------------------------------------------------
// Device A uploads an AES-GCM encrypted cookie jar; Device B downloads it
// ONCE using the unguessable pickup ID from the QR code. The server stores
// ciphertext only — the 256-bit encryption key travels inside the QR code
// and never touches the server, so the server cannot read the cookies.
//
// Single-use: the first successful download deletes the share. Short TTL
// (SHARE_TTL_MS, default 10 minutes) with a background sweeper.
//
// NOTE: in-memory — a server restart wipes pending shares. With a 10-minute
// TTL that is harmless: Device A simply shares again.
// =========================================================================

import { randomBytes } from "node:crypto";

import { config } from "./config.js";

export interface ShareBlob {
  iv: string;   // base64, 12-byte AES-GCM IV
  data: string; // base64 AES-GCM ciphertext (JSON cookie array)
}

export interface ShareRecord {
  id: string; // 32 lowercase hex chars (128-bit pickup ticket)
  blob: ShareBlob;
  cookieCount: number;
  siteCount: number;
  createdAt: string;
  expiresAt: number; // epoch ms
}

const SWEEP_INTERVAL_MS = 60_000;

export class ShareStore {
  private shares = new Map<string, ShareRecord>();
  private sweepTimer: NodeJS.Timeout;

  constructor() {
    this.sweepTimer = setInterval(() => {
      this.sweepExpired();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  create(
    blob: ShareBlob,
    cookieCount: number,
    siteCount: number
  ): ShareRecord {
    const now = Date.now();
    const record: ShareRecord = {
      id: randomBytes(16).toString("hex"),
      blob,
      cookieCount,
      siteCount,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + config.SHARE_TTL_MS
    };
    this.shares.set(record.id, record);
    return record;
  }

  /**
   * Single-use read: returns the record and deletes it, "expired" (also
   * deleted) when the TTL has passed, or undefined for an unknown ID.
   */
  consume(id: string): ShareRecord | "expired" | undefined {
    const record = this.shares.get(id);
    if (!record) return undefined;
    // Delete on first touch — even an expired read must not be retried.
    this.shares.delete(id);
    if (Date.now() >= record.expiresAt) return "expired";
    return record;
  }

  size(): number {
    return this.shares.size;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, record] of this.shares) {
      if (now >= record.expiresAt) {
        this.shares.delete(id);
      }
    }
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
  }
}
