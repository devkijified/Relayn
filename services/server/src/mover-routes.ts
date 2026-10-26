// =========================================================================
// RELAYN MOVER — cloud coordination routes (Fastify plugin, TypeScript)
// -------------------------------------------------------------------------
// Port of the Relayn Mover Go cloud server (relayn-mover/cmd/cloud),
// so the Mover apps point at this server (server.url in config.json,
// default https://relayn-server.onrender.com) exactly like the
// extension does. Response bodies mirror the Go endpoints field for
// field — the Go apps parse them — including the Go error shape
// { error: "<message>" } on these routes.
//
//   POST  /api/machines                          presence register/heartbeat
//   GET   /api/machines                          presence list (this account)
//   POST  /api/moves                             announce a move (manifest)
//   GET   /api/moves                             moves inbox (this account)
//   GET   /api/moves/:moveId/manifest            one move's manifest
//   POST  /api/moves/:moveId/status              update a move's status
//   GET   /api/moves/:moveId/chunks              chunk indexes held here
//   PUT   /api/moves/:moveId/chunks/:n           upload one sealed chunk
//   GET   /api/moves/:moveId/chunks/:n           download one sealed chunk
//
// Every endpoint is account-scoped by the X-Account-Id header
// (401 without a valid one). All lookups resolve inside that
// account's space only: another account's move reads as 404.
//
// Wiring (index.ts):
//   import { moverRoutes } from "./mover-routes.js";
//   import { MoverStore } from "./mover-store.js";
//   const moverStore = new MoverStore();
//   await app.register(moverRoutes, { moverStore });
//   // ... in shutdown(): moverStore.shutdown();
// =========================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { isValidMoveId, type MoverStore } from "./mover-store.js";

// Pre-shared account ID, same rule as the extension builds and the Go
// cloud's AccountIDValid: 8–64 URL-safe characters.
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Manifests describe whole laptops; allow far more than the share
// body limit (the Go server imposes no cap here).
const MANIFEST_BODY_LIMIT = 64 * 1024 * 1024;

// When the chunk cap is disabled (MOVER_MAX_CHUNK_MB=0), the parser
// still needs a finite limit — set it far beyond any real chunk.
const UNCAPPED_PARSER_LIMIT = 4 * 1024 * 1024 * 1024;

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

export async function moverRoutes(
  app: FastifyInstance,
  options: { moverStore: MoverStore }
): Promise<void> {
  const { moverStore } = options;
  const { maxChunkBytes } = moverStore.config;

  // Sealed chunk uploads arrive as raw application/octet-stream. This
  // parser is scoped to this plugin's routes; no other route in the
  // server accepts that content type.
  app.addContentTypeParser(
    "application/octet-stream",
    {
      parseAs: "buffer",
      bodyLimit: maxChunkBytes > 0 ? maxChunkBytes : UNCAPPED_PARSER_LIMIT
    },
    (_request, body, done) => {
      done(null, body);
    }
  );

  // The Go server answers an over-cap chunk with a plain 413 and a
  // fixed message; Fastify's parser raises its own error shape, so map
  // it back for this plugin's routes.
  app.setErrorHandler((error, _request, reply) => {
    const err = error as {
      code?: string;
      statusCode?: number;
      message?: string;
    };
    if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply
        .code(413)
        .send({ error: "chunk exceeds cloud.maxChunkMB" });
    }
    const status = err.statusCode ?? 500;
    return reply.code(status).send({ error: err.message ?? "error" });
  });

  // ------------------------------------------------------------------
  // Presence. POST registers or heartbeats (same role+name replaces);
  // GET lists this account's machines.
  // ------------------------------------------------------------------
  app.post("/api/machines", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    const body = (request.body ?? {}) as {
      role?: unknown;
      name?: unknown;
      address?: unknown;
    };
    moverStore.registerMachine(acc, {
      account: acc,
      role: typeof body.role === "string" ? body.role : "",
      name: typeof body.name === "string" ? body.name : "",
      address: typeof body.address === "string" ? body.address : ""
    });
    return { ok: "true" };
  });

  app.get("/api/machines", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    return moverStore.listMachines(acc);
  });

  // ------------------------------------------------------------------
  // Moves inbox.
  // ------------------------------------------------------------------
  app.post(
    "/api/moves",
    { bodyLimit: MANIFEST_BODY_LIMIT },
    async (request, reply) => {
      const acc = needAccount(request, reply);
      if (!acc) return;
      const body = (request.body ?? {}) as {
        moverName?: unknown;
        manifest?: unknown;
      };
      const manifest =
        body.manifest && typeof body.manifest === "object"
          ? (body.manifest as Record<string, unknown>)
          : undefined;
      if (!manifest || !isValidMoveId(manifest.moveId)) {
        return reply
          .code(400)
          .send({ error: "manifest with moveId required" });
      }
      const meta = await moverStore.announce(
        acc,
        typeof body.moverName === "string" ? body.moverName : "",
        manifest
      );
      return meta;
    }
  );

  app.get("/api/moves", async (request, reply) => {
    const acc = needAccount(request, reply);
    if (!acc) return;
    return moverStore.listMoves(acc);
  });

  // ------------------------------------------------------------------
  // One move: manifest, status, chunks. A move outside this account's
  // space (or with a malformed id) reads as 404, like the Go server.
  // ------------------------------------------------------------------
  async function requireMove(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<{ acc: string; moveId: string } | undefined> {
    const acc = needAccount(request, reply);
    if (!acc) return undefined;
    const params = request.params as { moveId: string };
    const moveId = String(params.moveId || "");
    if (
      !isValidMoveId(moveId) ||
      !(await moverStore.moveExists(acc, moveId))
    ) {
      reply.code(404).send({ error: "move not found" });
      return undefined;
    }
    return { acc, moveId };
  }

  app.get("/api/moves/:moveId/manifest", async (request, reply) => {
    const found = await requireMove(request, reply);
    if (!found) return;
    const manifest = await moverStore.getManifest(found.acc, found.moveId);
    if (!manifest) {
      return reply.code(404).send({ error: "move not found" });
    }
    return manifest;
  });

  app.post("/api/moves/:moveId/status", async (request, reply) => {
    const found = await requireMove(request, reply);
    if (!found) return;
    const body = (request.body ?? {}) as { status?: unknown };
    if (typeof body.status !== "string" || body.status === "") {
      return reply.code(400).send({ error: "status required" });
    }
    const meta = await moverStore.setStatus(
      found.acc,
      found.moveId,
      body.status
    );
    if (!meta) {
      return reply.code(404).send({ error: "move not found" });
    }
    return meta;
  });

  app.get("/api/moves/:moveId/chunks", async (request, reply) => {
    const found = await requireMove(request, reply);
    if (!found) return;
    const present = await moverStore.listPresentChunks(
      found.acc,
      found.moveId
    );
    return { present };
  });

  app.put("/api/moves/:moveId/chunks/:n", async (request, reply) => {
    const found = await requireMove(request, reply);
    if (!found) return;
    const params = request.params as { n: string };
    if (!/^\d+$/.test(params.n)) {
      return reply.code(400).send();
    }
    const sealed = request.body as Buffer;
    await moverStore.putChunk(
      found.acc,
      found.moveId,
      Number(params.n),
      Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed ?? "")
    );
    return { ok: "true" };
  });

  app.get("/api/moves/:moveId/chunks/:n", async (request, reply) => {
    const found = await requireMove(request, reply);
    if (!found) return;
    const params = request.params as { n: string };
    if (!/^\d+$/.test(params.n)) {
      return reply.code(400).send();
    }
    const chunk = await moverStore.getChunk(
      found.acc,
      found.moveId,
      Number(params.n)
    );
    if (!chunk) {
      return reply.code(404).send();
    }
    return reply
      .header("content-type", "application/octet-stream")
      .send(chunk);
  });
}
