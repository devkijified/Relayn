import Fastify from "fastify";
import cors from "@fastify/cors";

import { addAuditEvent } from "./audit.js";
import { config } from "./config.js";
import { SessionStore } from "./session-store.js";
import {
  closeAllWebSockets,
  registerWebSocketServer
} from "./websocket.js";
import type {
  CreateSessionResponse,
  ParticipantRole
} from "./types.js";

const app = Fastify({
  logger: true
});

const sessionStore = new SessionStore();

await app.register(cors, {
  origin: config.CORS_ORIGIN === "*"
    ? true
    : config.CORS_ORIGIN
});

app.get(
  "/",
  async () => {
    return {
      name: "Relayn Server",
      version: "0.1.0",
      status: "online"
    };
  }
);

app.get(
  "/health",
  async () => {
    return {
      status: "ok",
      service: "relayn-server",
      timestamp:
        new Date().toISOString()
    };
  }
);

app.post(
  "/api/sessions",
  async (_request, reply) => {
    const session =
      sessionStore.createSession();

    const response:
      CreateSessionResponse = {
        sessionId: session.id,
        code: session.code,
        status: session.status,
        expiresAt: session.expiresAt
      };

    return reply
      .code(201)
      .send(response);
  }
);

app.get(
  "/api/sessions/:sessionId",
  async (request, reply) => {
    const params =
      request.params as {
        sessionId: string;
      };

    const session =
      sessionStore.getById(
        params.sessionId
      );

    if (!session) {
      return reply
        .code(404)
        .send({
          error: "SESSION_NOT_FOUND",
          message:
            "Session was not found."
        });
    }

    return {
      sessionId: session.id,
      code: session.code,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      customerConnected:
        session.customer?.connected ??
        false,
      technicianConnected:
        session.technician?.connected ??
        false
    };
  }
);

app.get(
  "/api/sessions/code/:code",
  async (request, reply) => {
    const params =
      request.params as {
        code: string;
      };

    const session =
      sessionStore.getByCode(
        params.code
      );

    if (!session) {
      return reply
        .code(404)
        .send({
          error: "SESSION_NOT_FOUND",
          message:
            "No active session was found for this code."
        });
    }

    return {
      sessionId: session.id,
      code: session.code,
      status: session.status,
      expiresAt: session.expiresAt,
      customerConnected:
        session.customer?.connected ??
        false,
      technicianConnected:
        session.technician?.connected ??
        false
    };
  }
);

app.get(
  "/api/sessions/:sessionId/audit",
  async (request, reply) => {
    const params =
      request.params as {
        sessionId: string;
      };

    const session =
      sessionStore.getById(
        params.sessionId
      );

    if (!session) {
      return reply
        .code(404)
        .send({
          error: "SESSION_NOT_FOUND",
          message:
            "Session was not found."
        });
    }

    return {
      sessionId: session.id,
      events: session.audit
    };
  }
);

app.post(
  "/api/sessions/:sessionId/end",
  async (request, reply) => {
    const params =
      request.params as {
        sessionId: string;
      };

    const body =
      (request.body ?? {}) as {
        role?: ParticipantRole;
      };

    const session =
      sessionStore.getById(
        params.sessionId
      );

    if (!session) {
      return reply
        .code(404)
        .send({
          error: "SESSION_NOT_FOUND",
          message:
            "Session was not found."
        });
    }

    if (
      body.role !== "customer" &&
      body.role !== "technician"
    ) {
      return reply
        .code(400)
        .send({
          error: "INVALID_ROLE",
          message:
            "role must be customer or technician."
        });
    }

    if (session.status === "ENDED") {
      return {
        sessionId: session.id,
        status: session.status
      };
    }

    if (session.status === "EXPIRED") {
      return {
        sessionId: session.id,
        status: session.status
      };
    }

    session.status =
      "END_REQUESTED";

    session.endRequestedAt =
      new Date().toISOString();

    session.endRequestedBy =
      body.role;

    addAuditEvent(
      session,
      "END_REQUESTED",
      body.role
    );

    return {
      sessionId: session.id,
      status: session.status,
      timeoutMs:
        config.END_SESSION_TIMEOUT_MS
    };
  }
);

const websocketServer =
  registerWebSocketServer(
    app,
    sessionStore
  );

const cleanupTimer =
  setInterval(() => {
    const expired =
      sessionStore.cleanupExpired();

    for (const session of expired) {
      app.log.info(
        {
          sessionId: session.id
        },
        "Session expired"
      );
    }
  }, 30_000);

const shutdown = async (
  signal: string
) => {
  app.log.info(
    `${signal} received. Shutting down Relayn Server.`
  );

  clearInterval(cleanupTimer);

  closeAllWebSockets();

  websocketServer.close();

  await app.close();

  process.exit(0);
};

process.on(
  "SIGINT",
  () => {
    void shutdown("SIGINT");
  }
);

process.on(
  "SIGTERM",
  () => {
    void shutdown("SIGTERM");
  }
);

try {
  await app.listen({
    host: config.HOST,
    port: config.PORT
  });

  app.log.info(
    `Relayn Server listening on ${config.HOST}:${config.PORT}`
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
