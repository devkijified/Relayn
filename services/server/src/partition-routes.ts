// =========================================================================
// RELAYN: Partition HTTP routes (Fastify plugin, TypeScript)
// -------------------------------------------------------------------------
// Operator channel (account header only), same auth as headless doors:
//
//   GET  /api/partition/:machineId/status
//   POST /api/partition/:machineId/rebuild
//   GET  /api/partition/:machineId/browse?prefix=&offset=&limit=
//   GET  /api/partition/:machineId/document?path=
//   GET  /api/partition/:machineId/wallpaper
//   GET  /api/partition/:machineId/desktop-icons
//   GET  /api/partition/:machineId/pins
//   POST /api/partition/:machineId/mutate   { op, path, newName?, confirmed }
//   GET  /api/partition/:machineId/ledger
//   GET  /api/partition/:machineId/catalog                 (catalog doc)
//   GET  /api/partition/:machineId/catalog/browse?prefix=  (catalog ONLY)
//   POST /api/partition/:machineId/catalog/refresh         (merge revision)
//   GET  /api/partition/:machineId/seeder                  (server-held plan)
//   POST /api/partition/:machineId/seeder/bump { path, express? }
//        (on-demand; express puts this one file first of all)
//   POST /api/partition/:machineId/probe                   (manual Check now)
//   GET  /api/partition/:machineId/session-arm             (arm state)
//   POST /api/partition/:machineId/session-arm  { armed, hostHarvest? }
//        (set arm state; hostHarvest picks the Host-reads-it road)
//   POST /api/partition/:machineId/session-request         (record a need)
//   GET  /api/partition/session-requests                   (extension poll)
//   POST /api/partition/:machineId/session-envelope        (extension answer)
//   GET  /api/partition/:machineId/session-envelope        (Viewer take, once)
//   GET  /api/partition/session-envelopes                  (extension waiting list)
//   POST /api/partition/:machineId/session-envelope/ext-take
//        (extension take, once: single use across BOTH doors)
//
// Every route here is admin-side: when the account's licence is
// bound to an admin key, the preHandler guard requires the
// X-Admin-Key header (admin-key.ts); unbound accounts behave
// exactly as before.
//
// Session auto delivery: the arm flag, pending requests and staged
// envelopes live in partition-session.ts (state class storage,
// default OFF). Requests exist only for armed machines; a staged
// envelope is single use and expires with its share.
//
// Catalog-first (doc 23): the Partition lists from the CATALOG ONLY
// (ruling A). catalog/browse never merges a live Host browse. The legacy
// /browse above stays as the sealed-move view (FALLBACK + Files use).
//
// Viewer talks to the cloud with X-Account-Id (+ X-Machine-Id naming the
// Partition target). Never queues Host files-browse / desk-*. Source
// machines stay read-only.
//
// BASE: build stamp 202610281436, commit f987671.
// =========================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { needAdminKey } from "./admin-key.js";
import type { LicenseStore } from "./license-store.js";
import {
  HEADLESS_ONLINE_MS,
  isValidHeadlessMachineId,
  type MoverStore
} from "./mover-store.js";
import type { PartitionStore } from "./partition-store.js";
import type { PartitionCatalog } from "./partition-catalog.js";
import type { PartitionSeeder } from "./partition-seeder.js";
import type { PartitionSeederDriver } from "./partition-seeder-driver.js";
import {
  cleanSessionEnvelope,
  type PartitionSessionStore
} from "./partition-session.js";

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

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

// The machineId names a directory under the account's _partition
// ledger root, so it must be a plain headless machine id (the same
// rule enroll applies). Anything else, path segments included, reads
// as missing: it must never reach the store's disk paths.
function machineParam(request: FastifyRequest): string {
  const params = request.params as { machineId?: string };
  const id = String(params.machineId || "").trim();
  return isValidHeadlessMachineId(id) ? id : "";
}

export async function partitionRoutes(
  app: FastifyInstance,
  options: {
    partitionStore: PartitionStore;
    moverStore: MoverStore;
    catalog: PartitionCatalog;
    seeder: PartitionSeeder;
    driver: PartitionSeederDriver;
    sessionStore: PartitionSessionStore;
    licenseStore?: LicenseStore;
  }
): Promise<void> {
  const {
    partitionStore,
    moverStore,
    catalog,
    seeder,
    driver,
    sessionStore,
    licenseStore
  } = options;

  // The licence binding guard: every route in this plugin is an
  // admin-side door (the Viewer, the extension), so when the
  // caller's account is bound, the X-Admin-Key header is
  // required here before any handler runs. A request without a
  // valid account id falls through and the handlers answer
  // their own standing 401, exactly as before.
  app.addHook("preHandler", async (request, reply) => {
    const acc = accountOf(request);
    if (!acc) return;
    needAdminKey(licenseStore, request, reply, acc);
  });

  // Host-awake gate (same window the machine list uses). Seeding and the
  // three-state vocabulary turn on this, NOT on any mechanism word.
  function hostAwake(acc: string, machineId: string): boolean {
    const rec = moverStore.getHeadlessMachine(acc, machineId);
    return !!rec && Date.now() - rec.lastSeenMs <= HEADLESS_ONLINE_MS;
  }

  app.setErrorHandler((error, _request, reply) => {
    const err = error as {
      statusCode?: number;
      message?: string;
    };
    const status = err.statusCode ?? 500;
    return reply.code(status).send({ error: err.message ?? "error" });
  });

  function machineNameHint(acc: string, machineId: string): string {
    const rec = moverStore.getHeadlessMachine(acc, machineId);
    return rec && typeof rec.name === "string" ? rec.name : "";
  }

  app.get("/api/partition/:machineId/status", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    return partitionStore.status(
      acc,
      machineId,
      machineNameHint(acc, machineId)
    );
  });

  app.post("/api/partition/:machineId/rebuild", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    return partitionStore.rebuildFromSealedMoves(
      acc,
      machineId,
      machineNameHint(acc, machineId)
    );
  });

  app.get("/api/partition/:machineId/browse", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    const q = request.query as {
      prefix?: string;
      offset?: string;
      limit?: string;
    };
    return partitionStore.browse(acc, machineId, q.prefix || "", {
      machineName: machineNameHint(acc, machineId),
      offset: q.offset ? Number(q.offset) : 0,
      limit: q.limit ? Number(q.limit) : 200
    });
  });

  app.get("/api/partition/:machineId/document", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    const q = request.query as { path?: string };
    const packPath = String(q.path || "").trim();
    if (!packPath) return reply.code(400).send({ error: "path required" });
    const meta = await partitionStore.documentMeta(
      acc,
      machineId,
      packPath,
      machineNameHint(acc, machineId)
    );
    if (!meta) return reply.code(404).send({ error: "not found in Access Computer" });
    // Refs only: sealed bytes stay in the move store.
    return {
      packPath: meta.packPath,
      moveId: meta.moveId,
      size: meta.size,
      modTime: meta.modTime,
      category: meta.category,
      sha256: meta.sha256
    };
  });

  app.get("/api/partition/:machineId/wallpaper", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    const meta = await partitionStore.wallpaper(
      acc,
      machineId,
      machineNameHint(acc, machineId)
    );
    if (!meta) return { present: false };
    return { present: true, ...meta };
  });

  app.get(
    "/api/partition/:machineId/desktop-icons",
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      const machineId = machineParam(request);
      if (!machineId)
        return reply.code(400).send({ error: "machineId required" });
      const children = await partitionStore.desktopIcons(
        acc,
        machineId,
        machineNameHint(acc, machineId)
      );
      return { children };
    }
  );

  app.get("/api/partition/:machineId/pins", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    return partitionStore.pins(
      acc,
      machineId,
      machineNameHint(acc, machineId)
    );
  });

  app.post("/api/partition/:machineId/mutate", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    const body = (request.body ?? {}) as {
      op?: unknown;
      path?: unknown;
      newName?: unknown;
      confirmed?: unknown;
    };
    try {
      const rec = await partitionStore.mutate(acc, machineId, {
        op: body.op as "delete" | "rename",
        path: typeof body.path === "string" ? body.path : "",
        newName: typeof body.newName === "string" ? body.newName : undefined,
        confirmed: body.confirmed === true
      });
      return rec;
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply
        .code(err.statusCode ?? 500)
        .send({ error: err.message ?? "mutate failed" });
    }
  });

  app.get("/api/partition/:machineId/ledger", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    return { records: await partitionStore.listLedger(acc, machineId) };
  });

  // ---- catalog-first routes (doc 23) --------------------------------

  app.get("/api/partition/:machineId/catalog", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    const ledger = await partitionStore.listLedger(acc, machineId);
    const doc = await catalog.load(acc, machineId);
    const counts = await catalog.counts(acc, machineId, ledger);
    // Ledger stays authoritative over the catalog (ruling F): report the
    // live (ledger-overlaid) entries alongside the raw revision stamp.
    const entries = await catalog.liveEntries(acc, machineId, ledger);
    return {
      machineId,
      revisedAt: doc.revisedAt,
      hostCatalogAt: doc.hostCatalogAt,
      counts,
      entries
    };
  });

  app.get(
    "/api/partition/:machineId/catalog/browse",
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      const machineId = machineParam(request);
      if (!machineId)
        return reply.code(400).send({ error: "machineId required" });
      const q = request.query as {
        prefix?: string;
        offset?: string;
        limit?: string;
      };
      const ledger = await partitionStore.listLedger(acc, machineId);
      // RULING A: catalog ONLY. No live Host browse is merged here.
      return catalog.browse(acc, machineId, q.prefix || "", ledger, {
        offset: q.offset ? Number(q.offset) : 0,
        limit: q.limit ? Number(q.limit) : 200
      });
    }
  );

  app.post(
    "/api/partition/:machineId/catalog/refresh",
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      const machineId = machineParam(request);
      if (!machineId)
        return reply.code(400).send({ error: "machineId required" });
      const body = (request.body ?? {}) as { entries?: unknown };
      const raw = Array.isArray(body.entries) ? body.entries : [];
      const incoming = raw
        .map((row) => {
          const r = (row ?? {}) as Record<string, unknown>;
          const packPath =
            typeof r.packPath === "string"
              ? r.packPath
              : typeof r.path === "string"
                ? (r.path as string)
                : "";
          return {
            packPath,
            size: typeof r.size === "number" ? r.size : 0,
            modTime: typeof r.modTime === "number" ? r.modTime : 0,
            hash: typeof r.hash === "string" ? r.hash : undefined,
            category: typeof r.category === "string" ? r.category : undefined
          };
        })
        .filter((r) => r.packPath);
      const doc = await catalog.mergeHostCatalog(acc, machineId, incoming);
      const ledger = await partitionStore.listLedger(acc, machineId);
      const counts = await catalog.counts(acc, machineId, ledger);
      return { machineId, revisedAt: doc.revisedAt, counts };
    }
  );

  app.get("/api/partition/:machineId/seeder", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    const ledger = await partitionStore.listLedger(acc, machineId);
    return seeder.plan(acc, machineId, hostAwake(acc, machineId), ledger);
  });

  app.post("/api/partition/:machineId/seeder/bump", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    const body = (request.body ?? {}) as { path?: unknown; express?: unknown };
    const packPath =
      typeof body.path === "string"
        ? body.path.replace(/^\/+|\/+$/g, "")
        : "";
    if (!packPath) return reply.code(400).send({ error: "path required" });
    // Express is the single-file lane: the caller is opening this
    // file right now, so it goes ahead of every ordinary request.
    const express = body.express === true;
    const ledger = await partitionStore.listLedger(acc, machineId);
    const result = await seeder.bump(
      acc,
      machineId,
      packPath,
      hostAwake(acc, machineId),
      ledger,
      { express }
    );
    if (result.state === "unknown") {
      return reply.code(404).send({ error: "path not in catalog" });
    }
    return { path: packPath, state: result.state, express };
  });

  // Manual probe trigger (the Backup door's Check now): arms the
  // seeder driver's catalog probe for this machine so the next
  // driver pass walks it, whatever the probe cadence says. The
  // walk itself still runs inside the driver, on its own fences.
  app.post("/api/partition/:machineId/probe", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const machineId = machineParam(request);
    if (!machineId) return reply.code(400).send({ error: "machineId required" });
    const probe = driver.requestProbe(acc, machineId);
    return { machineId, probe };
  });

  // ---- session auto delivery -----------------------------------------
  // Arm state, session requests and staged envelopes. All account
  // scoped through the same guard as every route above. The arm
  // flag defaults OFF; requests are only recorded for armed
  // machines; a staged envelope is taken exactly once.

  app.get(
    "/api/partition/:machineId/session-arm",
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      const machineId = machineParam(request);
      if (!machineId)
        return reply.code(400).send({ error: "machineId required" });
      const state = await sessionStore.getArmState(acc, machineId);
      return { machineId, armed: state.armed, hostHarvest: state.hostHarvest };
    }
  );

  app.post(
    "/api/partition/:machineId/session-arm",
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      const machineId = machineParam(request);
      if (!machineId)
        return reply.code(400).send({ error: "machineId required" });
      const body = (request.body ?? {}) as {
        armed?: unknown;
        hostHarvest?: unknown;
      };
      if (typeof body.armed !== "boolean") {
        return reply.code(400).send({ error: "armed must be true or false" });
      }
      if (
        body.hostHarvest !== undefined &&
        typeof body.hostHarvest !== "boolean"
      ) {
        return reply
          .code(400)
          .send({ error: "hostHarvest must be true or false" });
      }
      const state = await sessionStore.setArm(
        acc,
        machineId,
        body.armed,
        typeof body.hostHarvest === "boolean" ? body.hostHarvest : undefined
      );
      return { machineId, armed: state.armed, hostHarvest: state.hostHarvest };
    }
  );

  // The Viewer records that a pull for this machine needs a
  // browser session. Unarmed machines are refused by name and
  // nothing is recorded for them.
  app.post(
    "/api/partition/:machineId/session-request",
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      const machineId = machineParam(request);
      if (!machineId)
        return reply.code(400).send({ error: "machineId required" });
      const result = await sessionStore.requestSession(acc, machineId);
      if (!result.armed) {
        return reply
          .code(409)
          .send({ error: "machine is not armed", armed: false });
      }
      return {
        machineId,
        armed: true,
        pending: true,
        requestId: result.request.requestId,
        requestedAt: result.request.requestedAt
      };
    }
  );

  // The extension poll: this account's pending session requests.
  // The extension authenticates with its pair account ID in the
  // X-Account-Id header, the standing Relayn account model. Only
  // armed machines ever appear here.
  app.get("/api/partition/session-requests", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const requests = await sessionStore.listRequests(acc);
    return {
      requests: requests.map((r) => ({
        machineId: r.machineId,
        requestId: r.request.requestId,
        requestedAt: r.request.requestedAt
      }))
    };
  });

  // The extension answers one pending request with the sealed
  // share envelope it built. The pending request clears in the
  // same write, so one request can only be answered once.
  app.post(
    "/api/partition/:machineId/session-envelope",
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      const machineId = machineParam(request);
      if (!machineId)
        return reply.code(400).send({ error: "machineId required" });
      const body = (request.body ?? {}) as {
        requestId?: unknown;
        envelope?: unknown;
      };
      const requestId =
        typeof body.requestId === "string" ? body.requestId : "";
      if (!requestId) {
        return reply.code(400).send({ error: "requestId required" });
      }
      const envelope = cleanSessionEnvelope(body.envelope);
      if (!envelope) {
        return reply.code(400).send({ error: "envelope is malformed" });
      }
      const result = await sessionStore.stageEnvelope(
        acc,
        machineId,
        requestId,
        envelope
      );
      if (result === "not-armed") {
        return reply
          .code(409)
          .send({ error: "machine is not armed", armed: false });
      }
      if (result === "no-request") {
        return reply
          .code(404)
          .send({ error: "no pending session request for this machine" });
      }
      if (result === "request-mismatch") {
        return reply
          .code(409)
          .send({ error: "requestId does not match the pending request" });
      }
      return { ok: true, machineId, requestId };
    }
  );

  // The Viewer takes the staged envelope. Single use: the store
  // deletes it before answering, so a second take is a 404. An
  // envelope older than its share lifetime answers 410.
  app.get(
    "/api/partition/:machineId/session-envelope",
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      const machineId = machineParam(request);
      if (!machineId)
        return reply.code(400).send({ error: "machineId required" });
      const result = await sessionStore.takeEnvelope(acc, machineId, "viewer");
      if (result === "none") {
        return reply
          .code(404)
          .send({ error: "no staged session for this machine" });
      }
      if (result === "not-armed") {
        return reply
          .code(409)
          .send({ error: "machine is not armed", armed: false });
      }
      if (result === "expired") {
        return reply
          .code(410)
          .send({ error: "the staged session has expired" });
      }
      return {
        machineId,
        requestId: result.staged.requestId,
        stagedAt: new Date(result.staged.stagedAt).toISOString(),
        envelope: result.staged.envelope
      };
    }
  );

  // ---- the extension take door -----------------------------------
  // A staged envelope is not addressed to one door: the extension
  // admin build can take it into whatever Chrome it runs in, the
  // same single use as the Viewer take above. Whichever door
  // takes first wins; the other then finds nothing waiting. The
  // store records which door took it (server-side audit only).

  // The extension asks what waits for its account: which machines
  // hold a fresh staged envelope, and since when. Names ride
  // along from the machine registry so the panel can name the
  // source machine in plain words.
  app.get("/api/partition/session-envelopes", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const staged = await sessionStore.listStaged(acc);
    return {
      envelopes: staged.map((s) => ({
        machineId: s.machineId,
        machineName: machineNameHint(acc, s.machineId),
        requestId: s.requestId,
        stagedAt: new Date(s.stagedAt).toISOString()
      }))
    };
  });

  // The extension takes one machine's staged envelope. Same
  // single use, same refusal shapes as the Viewer take.
  app.post(
    "/api/partition/:machineId/session-envelope/ext-take",
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      const machineId = machineParam(request);
      if (!machineId)
        return reply.code(400).send({ error: "machineId required" });
      const result = await sessionStore.takeEnvelope(acc, machineId, "ext");
      if (result === "none") {
        return reply
          .code(404)
          .send({ error: "no staged session for this machine" });
      }
      if (result === "not-armed") {
        return reply
          .code(409)
          .send({ error: "machine is not armed", armed: false });
      }
      if (result === "expired") {
        return reply
          .code(410)
          .send({ error: "the staged session has expired" });
      }
      return {
        machineId,
        requestId: result.staged.requestId,
        stagedAt: new Date(result.staged.stagedAt).toISOString(),
        envelope: result.staged.envelope
      };
    }
  );
}
