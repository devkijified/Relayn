// =========================================================================
// RELAYN — device-to-device share store (disk-backed, TypeScript)
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
// DURABLE: constructed with a state doc (index.ts passes the
// shared StateDocs and the key state/shares.json), every mutation
// is written
// through and the live shares are reloaded at boot, so a restart
// or redeploy no longer wipes pending shares. The single-use
// delete is persisted BEFORE consume() returns, so a spent share
// can never be resurrected by a restart. Records are stored in
// exactly the form this store already holds them: ciphertext for
// every share, plus the key for account shares only (the product
// decision above). TTLs are unchanged: expired records reload
// too and are retired by the same read paths and sweep as before,
// so an expired share still answers "expired", never "found".
// =========================================================================

import { randomBytes } from "node:crypto";

import { config } from "./config.js";
import type { StateDocs } from "./storage.js";

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
  private readonly docs?: StateDocs;
  private readonly docKey: string;

  constructor(docs?: StateDocs, docKey = "state/shares.json") {
    this.docs = docs;
    this.docKey = docKey;
    this.sweepTimer = setInterval(() => {
      void this.sweepExpired();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** Boot load: live shares reload from the state doc, if any. */
  async init(): Promise<void> {
    if (!this.docs) return;
    const saved = await this.docs.loadJSON<ShareRecord[]>(this.docKey);
    if (Array.isArray(saved)) {
      let dropped = 0;
      for (const rec of saved) {
        if (
          rec &&
          typeof rec === "object" &&
          typeof rec.id === "string" &&
          rec.id !== "" &&
          typeof rec.expiresAt === "number" &&
          rec.blob &&
          typeof rec.blob === "object"
        ) {
          this.shares.set(rec.id, rec);
        } else {
          dropped++;
        }
      }
      if (dropped > 0) {
        console.error(
          `[relayn] shares state doc ${this.docKey}: dropped ${dropped} malformed record(s) at load.`
        );
      }
    }
  }

  /** Write every live share through to the state doc, if any. */
  private async persist(): Promise<void> {
    if (!this.docs) return;
    await this.docs.saveJSON(this.docKey, [...this.shares.values()]);
  }

  async create(
    blob: ShareBlob,
    cookieCount: number,
    siteCount: number,
    opts?: { accountId?: string; keyB64?: string }
  ): Promise<ShareRecord> {
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
    await this.persist();
    return record;
  }

  /**
   * Read by pickup ID (QR flow).
   * Anonymous shares: single-use — first successful read deletes them.
   * Account shares: multi-use within their TTL.
   * Returns "expired" (and deletes) when the TTL has passed.
   */
  async consume(
    id: string
  ): Promise<ShareRecord | "expired" | undefined> {
    const record = this.shares.get(id);
    if (!record) return undefined;
    if (isExpired(record, Date.now())) {
      this.shares.delete(id);
      await this.persist();
      return "expired";
    }
    if (!record.accountId) {
      // Single-use: the delete is durable before the caller can
      // act on the record, so no restart can bring this share back.
      this.shares.delete(id);
      await this.persist();
    }
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
  async getAccountShare(
    accountId: string,
    id: string
  ): Promise<ShareRecord | "expired" | undefined> {
    const record = this.shares.get(id);
    if (!record || record.accountId !== accountId) return undefined;
    if (isExpired(record, Date.now())) {
      this.shares.delete(id);
      await this.persist();
      return "expired";
    }
    return record;
  }

  size(): number {
    return this.shares.size;
  }

  private async sweepExpired(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [id, record] of this.shares) {
      if (isExpired(record, now)) {
        this.shares.delete(id);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
  }
}
