// =========================================================================
// RELAYN: the bound admin key guard (TypeScript)
// -------------------------------------------------------------------------
// The licence binding (owner order, 2026-10-31): each account's
// admin surface is bound to its own licence by a key the licence
// store holds (license-store.ts). Builds issued for a bound
// account bake the key into their config; the callers send it as
// the X-Admin-Key header; admin-side routes for a bound account
// require it here.
//
// An account that is NOT bound answers "open" and behaves exactly
// as before: the account id remains the only credential, the
// standing Relayn model. Console-key routes are operator master
// doors and never pass through this guard. Machine-side routes
// (enroll, heartbeat, poll, results) never pass through it
// either: machine secrets already bind that side.
// =========================================================================

import type { FastifyReply, FastifyRequest } from "fastify";

import type { LicenseStore } from "./license-store.js";

export const ADMIN_KEY_REQUIRED_MESSAGE =
  "This account's builds are bound to an admin key, and this request did not carry one. Issue a fresh build for this account from the console.";

export const ADMIN_KEY_MISMATCH_MESSAGE =
  "The admin key this request carried does not match the key bound to this account. Issue a fresh build for this account from the console.";

/**
 * Gate one admin-side request for one account. Returns true when
 * the request may proceed (account unbound, or the key matches).
 * On refusal it answers 401 with the binding code and a plain
 * message, and returns false.
 */
export function needAdminKey(
  licenseStore: LicenseStore | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
  accountId: string
): boolean {
  if (!licenseStore) return true;
  const presented = request.headers["x-admin-key"];
  const verdict = licenseStore.verifyAdminKey(
    accountId,
    typeof presented === "string" ? presented : ""
  );
  if (verdict === "open" || verdict === "ok") return true;
  if (verdict === "missing") {
    reply.code(401).send({
      error: "ADMIN_KEY_REQUIRED",
      message: ADMIN_KEY_REQUIRED_MESSAGE
    });
    return false;
  }
  reply.code(401).send({
    error: "ADMIN_KEY_MISMATCH",
    message: ADMIN_KEY_MISMATCH_MESSAGE
  });
  return false;
}
