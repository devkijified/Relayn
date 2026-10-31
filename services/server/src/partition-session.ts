// =========================================================================
// RELAYN: Partition session auto delivery state (TypeScript)
// -------------------------------------------------------------------------
// Session auto delivery (owner order, 2026-10-28): for a machine the
// admin has ARMED, the browser session arrives on its own during
// pulls, so the Access Computer Chrome opens already signed in.
//
// This store holds the consent state and the short lived handoff
// for that flow, per account and per machine:
//
//   armed           the per machine arm flag. Default OFF. Arming is
//                   visible and revocable at any time: turning it off
//                   clears any pending request and any staged
//                   envelope for that machine at once, so nothing
//                   travels for a machine that is not armed.
//   pendingRequest  a session request the Viewer recorded for an
//                   armed machine. Requests are only ever created
//                   for armed machines. The extension on the machine
//                   discovers requests through the account poll and
//                   answers at most one at a time.
//   envelope        one sealed share envelope ({ v:2, server, id,
//                   key }) the extension staged in answer to the
//                   pending request. The envelope is single use: the
//                   Viewer takes it exactly once and this store
//                   deletes it before the take returns. It also
//                   expires after SESSION_ENVELOPE_TTL_MS, matching
//                   the single use share lifetime it points at.
//
// STORAGE: one document per account at
//   <account>/_partition/session-auto.json
// on the StateDocs store. That key sits under "/_partition/", so
// isBulkKey() in storage.ts classes it as state: it is never swept
// by the bulk window, exactly like the partition catalog and the
// mutate ledger beside it. Writes are single object write-through,
// durable before the call returns. The arm flag therefore survives
// restarts and redeploys until an admin turns it off.
//
// AUTH MODEL: the standing Relayn account model. Every route that
// touches this store is account scoped (X-Account-Id, possession of
// the account ID is the authorization, same as the partition routes
// and the share inbox). One account can never read or change
// another account's arm state, requests or envelopes.
// =========================================================================

import { randomBytes } from "node:crypto";

import type { StateDocs } from "./storage.js";

/** How long a staged envelope stays takeable (matches the share TTL). */
export const SESSION_ENVELOPE_TTL_MS = 10 * 60 * 1000;

export interface SessionEnvelope {
  v: 2;
  server: string;
  id: string;
  key: string;
}

export interface PendingSessionRequest {
  requestId: string;
  requestedAt: string; // RFC3339
}

export interface StagedSessionEnvelope {
  envelope: SessionEnvelope;
  requestId: string;
  stagedAt: number; // epoch ms
}

export interface MachineSessionState {
  armed: boolean;
  pendingRequest: PendingSessionRequest | null;
  staged: StagedSessionEnvelope | null;
  updatedAt: string; // RFC3339
}

interface AccountSessionDocument {
  accountId: string;
  machines: Record<string, MachineSessionState>;
  updatedAt: string; // RFC3339
}

const SHARE_ID_RE = /^[0-9a-f]{32}$/;
const ENVELOPE_HTTPS_RE = /^https:\/\/[^/\s]+$/;
const ENVELOPE_LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function rfc3339Now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Validate one sealed share envelope the exact way the extension
 * and the Viewer validate it: v must be 2, the server must be
 * https (plain http only for localhost), the id must be the
 * 32 hex pickup ticket, and the key must be base64 for exactly
 * 32 bytes. Returns the cleaned envelope, or null when malformed.
 */
export function cleanSessionEnvelope(
  input: unknown
): SessionEnvelope | null {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  if (e.v !== 2) return null;
  const server = String(e.server ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!ENVELOPE_HTTPS_RE.test(server) && !ENVELOPE_LOCAL_RE.test(server)) {
    return null;
  }
  const id = String(e.id ?? "")
    .trim()
    .toLowerCase();
  if (!SHARE_ID_RE.test(id)) return null;
  const key = String(e.key ?? "").trim();
  let raw: Buffer;
  try {
    raw = Buffer.from(key, "base64");
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  return { v: 2, server, id, key };
}

function emptyMachineState(): MachineSessionState {
  return {
    armed: false,
    pendingRequest: null,
    staged: null,
    updatedAt: rfc3339Now()
  };
}

/**
 * The per account session auto delivery store. See the file header
 * for the storage and consent rules. All reads and writes go
 * through the one account document, so the extension poll can list
 * an account's pending requests without scanning the object store.
 */
export class PartitionSessionStore {
  private docsCache = new Map<string, AccountSessionDocument>();

  constructor(private readonly docs: StateDocs) {}

  private objectKey(account: string): string {
    // Under _partition/: state class, never swept (see storage.ts).
    return `${account}/_partition/session-auto.json`;
  }

  /** Load (and cache) the account document; empty doc when absent. */
  async load(account: string): Promise<AccountSessionDocument> {
    const cached = this.docsCache.get(account);
    if (cached) return cached;
    const loaded = await this.docs.loadJSON<AccountSessionDocument>(
      this.objectKey(account)
    );
    const doc: AccountSessionDocument =
      loaded && typeof loaded === "object" && loaded.machines &&
      typeof loaded.machines === "object"
        ? {
            accountId: account,
            machines: loaded.machines,
            updatedAt: loaded.updatedAt || rfc3339Now()
          }
        : { accountId: account, machines: {}, updatedAt: rfc3339Now() };
    this.docsCache.set(account, doc);
    return doc;
  }

  private async save(doc: AccountSessionDocument): Promise<void> {
    doc.updatedAt = rfc3339Now();
    this.docsCache.set(doc.accountId, doc);
    await this.docs.saveJSON(this.objectKey(doc.accountId), doc);
  }

  private machine(
    doc: AccountSessionDocument,
    machineId: string
  ): MachineSessionState {
    let m = doc.machines[machineId];
    if (!m || typeof m !== "object") {
      m = emptyMachineState();
      doc.machines[machineId] = m;
    }
    if (typeof m.armed !== "boolean") m.armed = false;
    if (m.pendingRequest === undefined) m.pendingRequest = null;
    if (m.staged === undefined) m.staged = null;
    return m;
  }

  /** The arm flag for one machine. Default OFF for unknown machines. */
  async getArm(account: string, machineId: string): Promise<boolean> {
    const doc = await this.load(account);
    const m = doc.machines[machineId];
    return !!m && m.armed === true;
  }

  /**
   * Set the arm flag for one machine. Turning it OFF is a full
   * revoke: any pending request and any staged envelope for the
   * machine are cleared in the same write, so a session already in
   * flight at the moment of the revoke can never be delivered.
   */
  async setArm(
    account: string,
    machineId: string,
    armed: boolean
  ): Promise<MachineSessionState> {
    const doc = await this.load(account);
    const m = this.machine(doc, machineId);
    m.armed = armed === true;
    if (!m.armed) {
      m.pendingRequest = null;
      m.staged = null;
    }
    m.updatedAt = rfc3339Now();
    await this.save(doc);
    return m;
  }

  /**
   * Record a pending session request for one machine. Only armed
   * machines can hold a request: for an unarmed machine this
   * returns { armed: false } and records nothing. A second call
   * while a request is already pending returns the same request,
   * so repeated Viewer polls never stack up duplicate requests.
   */
  async requestSession(
    account: string,
    machineId: string
  ): Promise<
    | { armed: false }
    | { armed: true; pending: true; request: PendingSessionRequest }
  > {
    const doc = await this.load(account);
    const m = this.machine(doc, machineId);
    if (!m.armed) return { armed: false };
    if (m.pendingRequest) {
      return { armed: true, pending: true, request: m.pendingRequest };
    }
    const request: PendingSessionRequest = {
      requestId: "sr-" + randomBytes(10).toString("hex"),
      requestedAt: rfc3339Now()
    };
    m.pendingRequest = request;
    m.updatedAt = rfc3339Now();
    await this.save(doc);
    return { armed: true, pending: true, request };
  }

  /**
   * The extension poll view: this account's pending requests, one
   * entry per machine, armed machines only. A machine disarmed
   * after its request was recorded never appears here (disarming
   * clears the request; this filter is the second fence).
   */
  async listRequests(
    account: string
  ): Promise<Array<{ machineId: string; request: PendingSessionRequest }>> {
    const doc = await this.load(account);
    const out: Array<{ machineId: string; request: PendingSessionRequest }> =
      [];
    for (const [machineId, m] of Object.entries(doc.machines)) {
      if (m && m.armed === true && m.pendingRequest) {
        out.push({ machineId, request: m.pendingRequest });
      }
    }
    out.sort((a, b) => (a.machineId < b.machineId ? -1 : 1));
    return out;
  }

  /**
   * Stage the envelope the extension built in answer to a pending
   * request. Fences, each named by the caller: the machine must be
   * armed, a request must be pending, and the requestId must match
   * the pending request. On success the request is cleared in the
   * same write, so one request can only ever be answered once.
   */
  async stageEnvelope(
    account: string,
    machineId: string,
    requestId: string,
    envelope: SessionEnvelope
  ): Promise<"staged" | "not-armed" | "no-request" | "request-mismatch"> {
    const doc = await this.load(account);
    const m = this.machine(doc, machineId);
    if (!m.armed) return "not-armed";
    if (!m.pendingRequest) return "no-request";
    if (m.pendingRequest.requestId !== requestId) return "request-mismatch";
    m.staged = { envelope, requestId, stagedAt: Date.now() };
    m.pendingRequest = null;
    m.updatedAt = rfc3339Now();
    await this.save(doc);
    return "staged";
  }

  /**
   * Take the staged envelope for one machine. Single use: a fresh
   * envelope is deleted before this returns, so no restart and no
   * second reader can take it again. An envelope older than the
   * TTL answers "expired" and is deleted. Armed state is checked
   * again here, so a revoke between staging and taking still
   * blocks delivery.
   */
  async takeEnvelope(
    account: string,
    machineId: string
  ): Promise<
    | { staged: StagedSessionEnvelope }
    | "none"
    | "expired"
    | "not-armed"
  > {
    const doc = await this.load(account);
    const m = doc.machines[machineId];
    if (!m || !m.staged) return "none";
    if (m.armed !== true) {
      // Disarming already clears staged envelopes; this covers a
      // document written before that rule or by an older build.
      m.staged = null;
      m.updatedAt = rfc3339Now();
      await this.save(doc);
      return "not-armed";
    }
    const staged = m.staged;
    m.staged = null;
    m.updatedAt = rfc3339Now();
    await this.save(doc);
    if (Date.now() - staged.stagedAt > SESSION_ENVELOPE_TTL_MS) {
      return "expired";
    }
    return { staged };
  }

  /** Whether a fresh envelope is staged (no take, no delete). */
  async peekEnvelope(
    account: string,
    machineId: string
  ): Promise<boolean> {
    const doc = await this.load(account);
    const m = doc.machines[machineId];
    if (!m || m.armed !== true || !m.staged) return false;
    return Date.now() - m.staged.stagedAt <= SESSION_ENVELOPE_TTL_MS;
  }

  shutdown(): void {
    this.docsCache.clear();
  }
}
