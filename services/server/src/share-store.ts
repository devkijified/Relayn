// =========================================================================
// RELAYN — device-to-device share store (in-memory, TypeScript)
// -------------------------------------------------------------------------
// Two share kinds:
//
//   ANONYMOUS (no accountId)
//     Device A uploads an AES-GCM encrypted cookie jar; Device B downloads
//     it ONCE using the unguessable pickup ID from the QR code. The server
//     stores ciphertext only — the 256-bit key travels inside the QR code
//     and never touches the server. Single-use (deleted on first download),
//     short TTL (SHARE_TTL_MS, default 10 minutes).
//
//   ACCOUNT (accountId set — assigned account shared by admin + child)
//     The full share — ciphertext AND the decryption key — is stored under
//     the pre-shared account ID so the admin can pull it with one tap
//     (no QR scan needed). Deliberate trade-off, chosen by the product
//     owner: the server operator can technically read these cookies.
//     Multi-use within the TTL, long TTL (ACCOUNT_SHARE_TTL_MS, default
//     48 hours). Possession of the account ID IS the authorization.
//
// NOTE: in-memory — a server restart wipes pending shares.
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
  // Account shares only:
  accountId?: string; // pre-shared account both builds carry in config.json
  keyB64?: string;    // base64 AES key — stored ONLY for account shares
}

export interface ShareListItem {
  id: string;
  cookieCount: number;
  siteCount: number;
  createdAt: string;
  expiresAt: string; // ISO
}

const SWEEP_INTERVAL_MS = 60_000;

function isExpired(record: ShareRecord, now: number): boolean {
  return now >= record.expiresAt;
}

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
    siteCount: number,
    opts?: { accountId?: string; keyB64?: string }
  ): ShareRecord {
    const now = Date.now();
    const accountId = opts?.accountId;
    const record: ShareRecord = {
      id: randomBytes(16).toString("hex"),
      blob,
      cookieCount,
      siteCount,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + (accountId ? config.ACCOUNT_SHARE_TTL_MS : config.SHARE_TTL_MS)
    };
    if (accountId) {
      record.accountId = accountId;
      record.keyB64 = opts?.keyB64;
    }
    this.shares.set(record.id, record);
    return record;
  }

  /**
   * Read by pickup ID (QR flow).
   * Anonymous shares: single-use — first successful read deletes them.
   * Account shares: multi-use within their TTL.
   * Returns "expired" (and deletes) when the TTL has passed.
   */
  consume(id: string): ShareRecord | "expired" | undefined {
    const record = this.shares.get(id);
    if (!record) return undefined;
    if (isExpired(record, Date.now())) {
      this.shares.delete(id);
      return "expired";
    }
    if (!record.accountId) this.shares.delete(id);
    return record;
  }

  /**
   * Metadata list of a single account's live shares (no blobs, no keys).
   */
  listByAccount(accountId: string): ShareListItem[] {
    const now = Date.now();
    const out: ShareListItem[] = [];
    for (const record of this.shares.values()) {
      if (record.accountId !== accountId || isExpired(record, now)) continue;
      out.push({
        id: record.id,
        cookieCount: record.cookieCount,
        siteCount: record.siteCount,
        createdAt: record.createdAt,
        expiresAt: new Date(record.expiresAt).toISOString()
      });
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

  /**
   * Full account share (blob + key) for one-tap import. The record must
   * belong to the account and be live; otherwise undefined.
   */
  getAccountShare(accountId: string, id: string): ShareRecord | "expired" | undefined {
    const record = this.shares.get(id);
    if (!record || record.accountId !== accountId) return undefined;
    if (isExpired(record, Date.now())) {
      this.shares.delete(id);
      return "expired";
    }
    return record;
  }

  size(): number {
    return this.shares.size;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, record] of this.shares) {
      if (isExpired(record, now)) {
        this.shares.delete(id);
      }
    }
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
  }
}
