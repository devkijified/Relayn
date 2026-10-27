// =========================================================================
// RELAYN MOVER — headless machine API (Fastify plugin, TypeScript)
// -------------------------------------------------------------------------
// The machine-facing half of the headless track: Mover engines that
// run with NO signed-in user (installed as a service on a machine
// being retired). The engine enrolls once, then takes signed jobs
// from the cloud; the human verification happens in the console (see
// mover-console.ts), never zero-touch on the machine.
//
//   POST  /api/headless/enroll                  -> { machineSecret }
//   POST  /api/headless/heartbeat                state + job progress + desk report
//   GET   /api/headless/commands                 pending commands (clears)
//   POST  /api/headless/commands/:id/result      store a command result
//
// Plus the OPERATOR channel (account header only, no machine
// secret), used by the console and the RelaynAdminViewer app:
//
//   GET   /api/headless/machines                 this account's machines
//   POST  /api/headless/commands                 queue a command (X-Machine-Id
//                                                names the target; "start",
//                                                "desk-end", "view-end",
//                                                "files-fetch" and
//                                                "files-push" are signed
//                                                by the store at queue time)
//   GET   /api/headless/commands/:id             one command's state + result
//
// The machine channel has no enqueue route by design: a machine
// can never command itself, so it can never end its own
// Background Admin session.
//
// Every endpoint is account-scoped by the X-Account-Id header (401
// without a valid one), exactly like the Mover cloud routes. After
// enroll, every call also carries X-Machine-Id + X-Machine-Secret,
// verified against the stored record with a constant-time compare.
// Commands of type "start" arrive with a signature: HMAC-SHA256 hex
// over the canonical JSON of { id, type, payload }, keyed with the
// machine secret (see mover-store.ts: headlessCommandSignature). The
// engine MUST verify it before acting: a start exists only because
// an operator verified a selection and clicked start in the console.
//
// Command payloads:
//   scan    {}                                    result: the app inventory summary
//   browse  { prefix, offset?, limit? }           result: the app browse response
//   paths   { prefix }                            result: { prefix, paths: [...] }
//   start   { moveName, paths: [concrete paths] } (signed)
//   files-browse { prefix, offset?, limit? }      result: the app browse response, with modTime on each child
//   files-fetch  { moveName, paths: [concrete files] } (signed)
//   files-push   { moveId, destDir }              (signed)
// Scan/browse/paths results are the engine's own app shapes (the same
// JSON its local /api/inventory endpoints produce), passed through
// untouched so the console renders them like the app does.
// A files-fetch or files-push result may carry a "transfers" array
// of { direction, path, size, outcome }: the store folds each entry
// into the account's Files transfer ledger (see mover-store.ts:
// noteFilesTransfers), stamped with the server receipt time.
// Heartbeats never carry transfers; results only.
//
// Wiring (index.ts):
//   import { headlessRoutes } from "./mover-headless.js";
//   await app.register(headlessRoutes, { moverStore });
// =========================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { LicenseStore } from "./license-store.js";
import {
  isValidHeadlessMachineId,
  type HeadlessMachineRecord,
  type MoverStore
} from "./mover-store.js";

// Pre-shared account ID, same rule as the mover routes.
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Scan summaries, browse pages and result payloads can be sizeable;
// allow far more than the app-level default (chunk uploads keep
// their own parser limits in the mover routes plugin).
const HEADLESS_BODY_LIMIT = 64 * 1024 * 1024;

function accountOf(request: FastifyRequest): string {
  const id = request.headers["x-account-id"];
  if (typeof id !== "string" || !ACCOUNT_ID_RE.test(id)) return "";
  return id;
}

function needAccount(
  request: FastifyRequest,
  reply: FastifyReply
): string | undefined {
  const acc = accountOf(request);
  if (!acc) {
    reply.code(401).send({ error: "valid X-Account-Id required" });
    return undefined;
  }
  return acc;
}

export async function headlessRoutes(
  app: FastifyInstance,
  options: { moverStore: MoverStore; licenseStore?: LicenseStore }
): Promise<void> {
  const { moverStore, licenseStore } = options;

  // Same Go-style error shape as the mover routes plugin.
  app.setErrorHandler((error, _request, reply) => {
    const err = error as {
      code?: string;
      statusCode?: number;
      message?: string;
    };
    if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: "body too large" });
    }
    const status = err.statusCode ?? 500;
    return reply.code(status).send({ error: err.message ?? "error" });
  });

  /** Account + enrolled-machine auth for everything past enroll. */
  function needMachine(
    request: FastifyRequest,
    reply: FastifyReply
  ): { acc: string; machine: HeadlessMachineRecord } | undefined {
    const acc = needAccount(request, reply);
    if (!acc) return undefined;
    const machineId = request.headers["x-machine-id"];
    const secret = request.headers["x-machine-secret"];
    if (typeof machineId !== "string" || typeof secret !== "string") {
      reply
        .code(401)
        .send({ error: "X-Machine-Id and X-Machine-Secret required" });
      return undefined;
    }
    const machine = moverStore.verifyHeadlessMachine(acc, machineId, secret);
    if (!machine) {
      reply.code(401).send({ error: "machine auth failed" });
      return undefined;
    }
    return { acc, machine };
  }

  // ------------------------------------------------------------------
  // Enroll: account header only. Returns the per-machine secret once;
  // re-enrolling the same machineId mints a fresh secret and drops
  // its still-pending commands.
  // ------------------------------------------------------------------
  app.post(
    "/api/headless/enroll",
    { bodyLimit: HEADLESS_BODY_LIMIT },
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      // License gate: an account with any revoked license cannot
      // enroll new machines. Machines and sessions already running
      // are not touched; only this new enrollment is blocked.
      if (licenseStore && licenseStore.hasRevoked(acc)) {
        return reply.code(403).send({
          error: "LICENSE_REVOKED",
          message:
            "This account has a revoked license, so new enrollments are blocked. Restore the license in the console to allow enrollments again."
        });
      }
      const body = (request.body ?? {}) as {
        machineId?: unknown;
        name?: unknown;
        os?: unknown;
        profiles?: unknown;
        capabilities?: unknown;
        interactiveUser?: unknown;
        interactiveAway?: unknown;
        sessions?: unknown;
        runMode?: unknown;
      };
      if (!isValidHeadlessMachineId(body.machineId)) {
        return reply.code(400).send({
          error:
            "machineId must be 1-128 URL-safe characters starting alphanumeric"
        });
      }
      const rec = moverStore.enrollHeadlessMachine(acc, {
        machineId: body.machineId,
        name: typeof body.name === "string" ? body.name : "",
        os: typeof body.os === "string" ? body.os : "",
        profiles: body.profiles ?? null,
        capabilities: body.capabilities ?? null,
        interactiveUser: body.interactiveUser,
        interactiveAway: body.interactiveAway,
        sessionsDiag: body.sessions,
        runMode: body.runMode
      });
      return { machineId: rec.machineId, machineSecret: rec.secret };
    }
  );

  // ------------------------------------------------------------------
  // Heartbeat: lastSeen, engine state, current job + progress, the
  // Background Admin desk report and the View Screen view report
  // (each a live session snapshot, or the ended report the engine
  // sends exactly once after an idle or session-gone end), and
  // who is signed in at the console right now.
  // ------------------------------------------------------------------
  app.post("/api/headless/heartbeat", async (request, reply) => {
    const found = needMachine(request, reply);
    if (!found) return;
    const body = (request.body ?? {}) as {
      state?: unknown;
      jobId?: unknown;
      progress?: unknown;
      desk?: unknown;
      view?: unknown;
      interactiveUser?: unknown;
      interactiveAway?: unknown;
      sessions?: unknown;
      poll?: unknown;
      runMode?: unknown;
    };
    moverStore.heartbeatHeadless(found.acc, found.machine.machineId, {
      ...body,
      sessionsDiag: body.sessions
    });
    return { ok: "true" };
  });

  // ------------------------------------------------------------------
  // Operator channel (account header only; NO machine secret):
  // this is how the console and the RelaynAdminViewer app drive
  // machines. It can list the account's machines, queue a command
  // for one (the store signs "start", "desk-end", "view-end",
  // "files-fetch" and "files-push" with the machine's secret
  // server-side, so those commands exist only
  // because an operator queued them here), and read a command
  // back. The machine channel above deliberately has NO enqueue
  // route: a machine can poll and post results, never command
  // itself, so it can never end (or open) its own desk session.
  // ------------------------------------------------------------------
  app.get("/api/headless/machines", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    return { machines: moverStore.listHeadlessMachines(acc) };
  });

  app.post(
    "/api/headless/commands",
    { bodyLimit: HEADLESS_BODY_LIMIT },
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      const machineId = request.headers["x-machine-id"];
      if (typeof machineId !== "string" || !machineId) {
        return reply
          .code(400)
          .send({ error: "X-Machine-Id header required" });
      }
      const body = (request.body ?? {}) as {
        type?: unknown;
        payload?: unknown;
        id?: unknown;
      };
      if (typeof body.type !== "string" || !body.type) {
        return reply.code(400).send({ error: "command type required" });
      }
      const payload =
        body.payload &&
        typeof body.payload === "object" &&
        !Array.isArray(body.payload)
          ? (body.payload as Record<string, unknown>)
          : {};
      const cmd = moverStore.queueHeadlessCommand(
        acc,
        machineId,
        body.type,
        payload
      );
      if (!cmd) {
        return reply.code(404).send({ error: "machine not enrolled" });
      }
      return { ok: "true", commandId: cmd.id };
    }
  );

  app.get("/api/headless/commands/:id", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const params = request.params as { id: string };
    const cmd = moverStore.getHeadlessCommand(acc, String(params.id || ""));
    if (!cmd) {
      return reply.code(404).send({ error: "command not found" });
    }
    return {
      commandId: cmd.id,
      type: cmd.type,
      status: cmd.status,
      result: cmd.result ?? null
    };
  });

  // ------------------------------------------------------------------
  // Command poll: returns this machine's pending commands in queue
  // order and clears the pending queue (they read as delivered).
  //
  // CONTRACT: the response body is the BARE ARRAY of commands.
  // That is the documented protocol shape, what the Go cloud
  // serves, and what the engine's poll decodes. This route once
  // wrapped the array in an envelope ({"commands": [...]}): every
  // poll against production then failed to decode on the engine,
  // so no command (desk, view, files, start) ever executed while
  // enroll and heartbeats kept the machine looking alive (the
  // owner's dead Viewer, 2026-10-27). The engine now tolerates
  // both shapes, and the test suite pins this route to the array.
  // ------------------------------------------------------------------
  app.get("/api/headless/commands", async (request, reply) => {
    const found = needMachine(request, reply);
    if (!found) return;
    return moverStore.takeHeadlessCommands(found.acc, found.machine.machineId);
  });

  // ------------------------------------------------------------------
  // Command result: body is { result: ... } (a bare body is stored
  // as-is). The console reads it back through its result endpoint.
  // Storing a result also folds it where the store keeps ledgers:
  // desk and view results feed their session ledgers, and a
  // files-fetch or files-push result's "transfers" array folds
  // into the Files transfer ledger (mover-store.ts).
  // ------------------------------------------------------------------
  app.post(
    "/api/headless/commands/:id/result",
    { bodyLimit: HEADLESS_BODY_LIMIT },
    async (request, reply) => {
      const found = needMachine(request, reply);
      if (!found) return;
      const params = request.params as { id: string };
      const body = request.body as Record<string, unknown> | null;
      const result =
        body && typeof body === "object" && "result" in body
          ? body.result
          : (body ?? null);
      const stored = moverStore.storeHeadlessResult(
        found.acc,
        found.machine.machineId,
        String(params.id || ""),
        result
      );
      if (!stored) {
        return reply.code(404).send({ error: "command not found" });
      }
      return { ok: "true" };
    }
  );
}
