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
//   POST /api/partition/:machineId/seeder/bump { path }    (on-demand)
//   POST /api/partition/:machineId/probe                   (manual Check now)
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

import {
  HEADLESS_ONLINE_MS,
  isValidHeadlessMachineId,
  type MoverStore
} from "./mover-store.js";
import type { PartitionStore } from "./partition-store.js";
import type { PartitionCatalog } from "./partition-catalog.js";
import type { PartitionSeeder } from "./partition-seeder.js";
import type { PartitionSeederDriver } from "./partition-seeder-driver.js";

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
  }
): Promise<void> {
  const { partitionStore, moverStore, catalog, seeder, driver } = options;

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
    if (!meta) return reply.code(404).send({ error: "not found in Partition" });
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
    const body = (request.body ?? {}) as { path?: unknown };
    const packPath =
      typeof body.path === "string"
        ? body.path.replace(/^\/+|\/+$/g, "")
        : "";
    if (!packPath) return reply.code(400).send({ error: "path required" });
    const ledger = await partitionStore.listLedger(acc, machineId);
    const result = await seeder.bump(
      acc,
      machineId,
      packPath,
      hostAwake(acc, machineId),
      ledger
    );
    if (result.state === "unknown") {
      return reply.code(404).send({ error: "path not in catalog" });
    }
    return { path: packPath, state: result.state };
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
}
