// =========================================================================
// RELAYN — encrypted cookie backup store (disk-backed, TypeScript)
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
// DURABLE: constructed with a state file (index.ts passes
// <MOVER_DATA_DIR>/state/backups.json), every mutation, audit
// events included, is written through and the backups are
// reloaded at boot, so a restart or redeploy no longer wipes
// them. Records are stored in exactly the form this store
// already holds them: ciphertext only. Expired records reload
// too and are retired by the same read path and sweep as
// before, so an expired backup still answers "expired".
// =========================================================================

import { randomUUID } from "node:crypto";

import { config } from "./config.js";
import { loadStateFile, saveStateFile } from "./state-file.js";

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
    private readonly stateFile?: string;

    constructor(stateFile?: string) {
        this.stateFile = stateFile;
        if (this.stateFile) {
            const saved = loadStateFile<BackupRecord[]>(this.stateFile);
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
                        if (!Array.isArray(rec.audit)) rec.audit = [];
                        this.backups.set(rec.id, rec);
                    } else {
                        dropped++;
                    }
                }
                if (dropped > 0) {
                    console.error(
                        `[relayn] backups state file ${this.stateFile}: dropped ${dropped} malformed record(s) at load.`
                    );
                }
            }
        }
        this.sweepTimer = setInterval(() => {
            this.sweepExpired();
        }, SWEEP_INTERVAL_MS);
        this.sweepTimer.unref();
    }

    /** Write every held backup through to the state file, if any. */
    private persist(): void {
        if (!this.stateFile) return;
        saveStateFile(this.stateFile, [...this.backups.values()]);
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
        this.persist();
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
            this.persist();
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
        this.persist();
    }

    /** How many backups are currently held (the console Overview reads this). */
    size(): number {
        return this.backups.size;
    }

    delete(id: string, ip: string): boolean {
        const record = this.backups.get(id);
        if (!record) return false;
        record.audit.push({
            t: new Date().toISOString(),
            event: "BACKUP_DELETED",
            ip
        });
        const deleted = this.backups.delete(id);
        if (deleted) this.persist();
        return deleted;
    }

    private sweepExpired(): void {
        const now = Date.now();
        let changed = false;
        for (const [id, record] of this.backups) {
            if (now >= record.expiresAt) {
                record.audit.push({
                    t: new Date().toISOString(),
                    event: "BACKUP_EXPIRED",
                    ip: "-"
                });
                this.backups.delete(id);
                changed = true;
            }
        }
        if (changed) this.persist();
    }

    shutdown(): void {
        clearInterval(this.sweepTimer);
    }
}
