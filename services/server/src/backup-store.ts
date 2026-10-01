// =========================================================================
// RELAYN — encrypted cookie backup store (in-memory, TypeScript)
// -------------------------------------------------------------------------
// Stores ONLY ciphertext. The passphrase never leaves the browser: the
// extension encrypts with PBKDF2 + AES-GCM (WebCrypto) and uploads
// { salt, iv, iterations, data }. A wrong passphrase fails at decrypt
// time on the client (AES-GCM auth tag) — the server cannot verify it
// and never sees plaintext.
//
// Each backup has a TTL (BACKUP_TTL_MS, default 7 days) and its own
// audit trail: UPLOADED / DOWNLOADED / DELETED / EXPIRED with timestamps
// and uploader/downloader IPs. No approval step: possession of the
// unguessable backup ID plus the passphrase IS the authorization.
//
// NOTE: in-memory — a server restart wipes backups. Fine for testing;
// use persistent storage (SQLite/file) for production.
// =========================================================================

import { randomUUID } from "node:crypto";

import { config } from "./config.js";

export interface BackupBlob {
    salt: string;       // base64
    iv: string;         // base64
    iterations: number; // PBKDF2 iterations
    data: string;       // base64 AES-GCM ciphertext
}

export interface BackupAuditEvent {
    t: string;
    event: "BACKUP_UPLOADED" | "BACKUP_DOWNLOADED" | "BACKUP_DELETED" | "BACKUP_EXPIRED";
    ip: string;
}

export interface BackupRecord {
    id: string;
    blob: BackupBlob;
    siteDomain: string;
    cookieCount: number;
    createdAt: string;
    expiresAt: number; // epoch ms
    audit: BackupAuditEvent[];
}

const SWEEP_INTERVAL_MS = 60_000;

export class BackupStore {
    private backups = new Map<string, BackupRecord>();
    private sweepTimer: NodeJS.Timeout;

    constructor() {
        this.sweepTimer = setInterval(() => {
            this.sweepExpired();
        }, SWEEP_INTERVAL_MS);
        this.sweepTimer.unref();
    }

    create(
        blob: BackupBlob,
        siteDomain: string,
        cookieCount: number,
        ip: string
    ): BackupRecord {
        const now = Date.now();
        const record: BackupRecord = {
            id: randomUUID(),
            blob,
            siteDomain,
            cookieCount,
            createdAt: new Date(now).toISOString(),
            expiresAt: now + config.BACKUP_TTL_MS,
            audit: [{ t: new Date(now).toISOString(), event: "BACKUP_UPLOADED", ip }]
        };
        this.backups.set(record.id, record);
        return record;
    }

    /**
     * Returns the record, "expired" (and deletes it), or undefined.
     */
    get(id: string): BackupRecord | "expired" | undefined {
        const record = this.backups.get(id);
        if (!record) return undefined;
        if (Date.now() >= record.expiresAt) {
            record.audit.push({
                t: new Date().toISOString(),
                event: "BACKUP_EXPIRED",
                ip: "-"
            });
            this.backups.delete(id);
            return "expired";
        }
        return record;
    }

    recordDownload(record: BackupRecord, ip: string): void {
        record.audit.push({
            t: new Date().toISOString(),
            event: "BACKUP_DOWNLOADED",
            ip
        });
    }

    delete(id: string, ip: string): boolean {
        const record = this.backups.get(id);
        if (!record) return false;
        record.audit.push({
            t: new Date().toISOString(),
            event: "BACKUP_DELETED",
            ip
        });
        return this.backups.delete(id);
    }

    private sweepExpired(): void {
        const now = Date.now();
        for (const [id, record] of this.backups) {
            if (now >= record.expiresAt) {
                record.audit.push({
                    t: new Date().toISOString(),
                    event: "BACKUP_EXPIRED",
                    ip: "-"
                });
                this.backups.delete(id);
            }
        }
    }

    shutdown(): void {
        clearInterval(this.sweepTimer);
    }
}
