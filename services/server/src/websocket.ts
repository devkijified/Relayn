import type { IncomingMessage } from "node:http";
import { URL } from "node:url";

import type { FastifyInstance } from "fastify";
import { WebSocketServer, WebSocket } from "ws";

import { addAuditEvent } from "./audit.js";
import { config } from "./config.js";
import { SessionStore } from "./session-store.js";
import type {
  ParticipantRole,
  Session
} from "./types.js";

interface ClientConnection {
  socket: WebSocket;
  sessionId: string;
  role: ParticipantRole;
  participantId: string;
}

const clients = new Set<ClientConnection>();

function send(
  socket: WebSocket,
  type: string,
  payload: unknown
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      type,
      payload
    })
  );
}

function sendError(
  socket: WebSocket,
  code: string,
  message: string
): void {
  send(socket, "error", {
    code,
    message
  });
}

function broadcastToSession(
  sessionId: string,
  type: string,
  payload: unknown,
  excludeSocket?: WebSocket
): void {
  for (const client of clients) {
    if (
      client.sessionId === sessionId &&
      client.socket !== excludeSocket
    ) {
      send(client.socket, type, payload);
    }
  }
}

function sendSessionState(
  session: Session
): void {
  const payload = {
    sessionId: session.id,
    code: session.code,
    status: session.status,
    customerConnected:
      session.customer?.connected ?? false,
    technicianConnected:
      session.technician?.connected ?? false,
    expiresAt: session.expiresAt
  };

  broadcastToSession(
    session.id,
    "session.state",
    payload
  );
}

function getClientForRole(
  sessionId: string,
  role: ParticipantRole
): ClientConnection | undefined {
  return [...clients].find(
    (client) =>
      client.sessionId === sessionId &&
      client.role === role
  );
}

function endSession(
  sessionStore: SessionStore,
  session: Session,
  auditType:
    | "END_CONFIRMED"
    | "END_TIMEOUT"
): void {
  session.status = "ENDED";

  addAuditEvent(
    session,
    auditType
  );

  addAuditEvent(
    session,
    "SESSION_ENDED"
  );

  broadcastToSession(
    session.id,
    "session.ended",
    {
      sessionId: session.id,
      reason:
        auditType === "END_TIMEOUT"
          ? "END_REQUEST_TIMEOUT"
          : "END_CONFIRMED"
    }
  );

  sendSessionState(session);
}

function handleMessage(
  connection: ClientConnection,
  sessionStore: SessionStore,
  rawMessage: string
): void {
  let message: {
    type?: string;
    payload?: any;
  };

  try {
    message = JSON.parse(rawMessage);
  } catch {
    sendError(
      connection.socket,
      "INVALID_JSON",
      "Message must be valid JSON."
    );

    return;
  }

  const session = sessionStore.getById(
    connection.sessionId
  );

  if (!session) {
    sendError(
      connection.socket,
      "SESSION_NOT_FOUND",
      "Session no longer exists."
    );

    return;
  }

  sessionStore.touchParticipant(
    session,
    connection.role
  );

  switch (message.type) {
    case "session.request": {
      if (connection.role !== "technician") {
        sendError(
          connection.socket,
          "FORBIDDEN",
          "Only the technician can request a session."
        );

        return;
      }

      if (
        session.status !==
        "WAITING_FOR_TECHNICIAN"
      ) {
        sendError(
          connection.socket,
          "INVALID_STATE",
          `Cannot request session while status is ${session.status}.`
        );

        return;
      }

      session.status = "TECHNICIAN_REQUESTED";

      addAuditEvent(
        session,
        "TECHNICIAN_REQUESTED",
        "technician"
      );

      const customer = getClientForRole(
        session.id,
        "customer"
      );

      if (customer) {
        send(
          customer.socket,
          "session.requested",
          {
            sessionId: session.id,
            code: session.code
          }
        );
      }

      sendSessionState(session);
      return;
    }

    case "session.approve": {
      if (connection.role !== "customer") {
        sendError(
          connection.socket,
          "FORBIDDEN",
          "Only the customer can approve a session."
        );

        return;
      }

      if (
        session.status !==
        "TECHNICIAN_REQUESTED"
      ) {
        sendError(
          connection.socket,
          "INVALID_STATE",
          `Cannot approve session while status is ${session.status}.`
        );

        return;
      }

      session.status = "CONNECTED";

      addAuditEvent(
        session,
        "CUSTOMER_APPROVED",
        "customer"
      );

      addAuditEvent(
        session,
        "SESSION_CONNECTED"
      );

      broadcastToSession(
        session.id,
        "session.approved",
        {
          sessionId: session.id
        }
      );

      sendSessionState(session);
      return;
    }

    case "session.reject": {
      if (connection.role !== "customer") {
        sendError(
          connection.socket,
          "FORBIDDEN",
          "Only the customer can reject a session."
        );

        return;
      }

      if (
        session.status !==
        "TECHNICIAN_REQUESTED"
      ) {
        sendError(
          connection.socket,
          "INVALID_STATE",
          `Cannot reject session while status is ${session.status}.`
        );

        return;
      }

      session.status =
        "WAITING_FOR_TECHNICIAN";

      addAuditEvent(
        session,
        "CUSTOMER_REJECTED",
        "customer"
      );

      broadcastToSession(
        session.id,
        "session.rejected",
        {
          sessionId: session.id
        }
      );

      sendSessionState(session);
      return;
    }

    case "session.end.request": {
      if (
        session.status !== "CONNECTED"
      ) {
        sendError(
          connection.socket,
          "INVALID_STATE",
          `Cannot end session while status is ${session.status}.`
        );

        return;
      }

      session.status = "END_REQUESTED";
      session.endRequestedAt =
        new Date().toISOString();
      session.endRequestedBy =
        connection.role;

      addAuditEvent(
        session,
        "END_REQUESTED",
        connection.role
      );

      const otherRole: ParticipantRole =
        connection.role === "customer"
          ? "technician"
          : "customer";

      const otherClient =
        getClientForRole(
          session.id,
          otherRole
        );

      if (otherClient) {
        send(
          otherClient.socket,
          "session.end.requested",
          {
            sessionId: session.id,
            requestedBy: connection.role,
            timeoutMs:
              config.END_SESSION_TIMEOUT_MS
          }
        );
      }

      send(
        connection.socket,
        "session.end.pending",
        {
          sessionId: session.id,
          timeoutMs:
            config.END_SESSION_TIMEOUT_MS
        }
      );

      sendSessionState(session);

      setTimeout(() => {
        const currentSession =
          sessionStore.getById(session.id);

        if (
          currentSession &&
          currentSession.status ===
            "END_REQUESTED"
        ) {
          endSession(
            sessionStore,
            currentSession,
            "END_TIMEOUT"
          );
        }
      }, config.END_SESSION_TIMEOUT_MS);

      return;
    }

    case "session.end.confirm": {
      if (
        session.status !== "END_REQUESTED"
      ) {
        sendError(
          connection.socket,
          "INVALID_STATE",
          "There is no pending end-session request."
        );

        return;
      }

      endSession(
        sessionStore,
        session,
        "END_CONFIRMED"
      );

      return;
    }

    case "ping": {
      send(
        connection.socket,
        "pong",
        {
          timestamp:
            new Date().toISOString()
        }
      );

      return;
    }

    case "signal": {
      const targetRole =
        message.payload?.targetRole;

      if (
        targetRole !== "customer" &&
        targetRole !== "technician"
      ) {
        sendError(
          connection.socket,
          "INVALID_TARGET",
          "targetRole must be customer or technician."
        );

        return;
      }

      if (
        targetRole === connection.role
      ) {
        sendError(
          connection.socket,
          "INVALID_TARGET",
          "Cannot send signaling data to yourself."
        );

        return;
      }

      if (
        session.status !== "CONNECTED"
      ) {
        sendError(
          connection.socket,
          "SESSION_NOT_CONNECTED",
          "Signaling is only allowed after the session is connected."
        );

        return;
      }

      const target =
        getClientForRole(
          session.id,
          targetRole
        );

      if (!target) {
        sendError(
          connection.socket,
          "TARGET_OFFLINE",
          "The target participant is not connected."
        );

        return;
      }

      send(
        target.socket,
        "signal",
        {
          fromRole: connection.role,
          data: message.payload?.data
        }
      );

      return;
    }

    default:
      sendError(
        connection.socket,
        "UNKNOWN_MESSAGE",
        `Unknown message type: ${message.type ?? "undefined"}`
      );
  }
}

export function registerWebSocketServer(
  app: FastifyInstance,
  sessionStore: SessionStore
): WebSocketServer {
  const websocketServer =
    new WebSocketServer({
      noServer: true
    });

  app.server.on(
    "upgrade",
    (
      request: IncomingMessage,
      socket,
      head
    ) => {
      try {
        const host =
          request.headers.host ??
          "localhost";

        const url = new URL(
          request.url ?? "/",
          `http://${host}`
        );

        if (url.pathname !== "/ws") {
          socket.destroy();
          return;
        }

        const sessionId =
          url.searchParams.get(
            "sessionId"
          );

        const code =
          url.searchParams.get("code");

        const role =
          url.searchParams.get("role") as
            | ParticipantRole
            | null;

        if (
          !sessionId ||
          !code ||
          !role
        ) {
          socket.destroy();
          return;
        }

        if (
          role !== "customer" &&
          role !== "technician"
        ) {
          socket.destroy();
          return;
        }

        const session =
          sessionStore.getById(
            sessionId
          );

        if (
          !session ||
          session.code !== code
        ) {
          socket.destroy();
          return;
        }

        if (
          session.status === "ENDED" ||
          session.status === "EXPIRED"
        ) {
          socket.destroy();
          return;
        }

        if (
          role === "customer" &&
          session.customer?.connected
        ) {
          socket.destroy();
          return;
        }

        if (
          role === "technician" &&
          session.technician?.connected
        ) {
          socket.destroy();
          return;
        }

        websocketServer.handleUpgrade(
          request,
          socket,
          head,
          (ws) => {
            websocketServer.emit(
              "connection",
              ws,
              request,
              session,
              role
            );
          }
        );
      } catch {
        socket.destroy();
      }
    }
  );

  websocketServer.on(
    "connection",
    (
      socket: WebSocket,
      _request: IncomingMessage,
      session: Session,
      role: ParticipantRole
    ) => {
      const participant =
        sessionStore.addParticipant(
          session,
          role
        );

      const connection: ClientConnection = {
        socket,
        sessionId: session.id,
        role,
        participantId:
          participant.id
      };

      clients.add(connection);

      if (role === "technician") {
        addAuditEvent(
          session,
          "TECHNICIAN_JOINED",
          "technician"
        );
      }

      send(
        socket,
        "connected",
        {
          sessionId: session.id,
          code: session.code,
          role,
          status: session.status
        }
      );

      sendSessionState(session);

      socket.on(
        "message",
        (data) => {
          handleMessage(
            connection,
            sessionStore,
            data.toString()
          );
        }
      );

      socket.on(
        "close",
        () => {
          clients.delete(connection);

          sessionStore.removeParticipant(
            session,
            role
          );

          addAuditEvent(
            session,
            "PARTICIPANT_DISCONNECTED",
            role
          );

          sendSessionState(session);
        }
      );

      socket.on(
        "error",
        () => {
          clients.delete(connection);
        }
      );

      socket.on(
        "pong",
        () => {
          sessionStore.touchParticipant(
            session,
            role
          );
        }
      );
    }
  );

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (
        client.socket.readyState !==
        WebSocket.OPEN
      ) {
        continue;
      }

      client.socket.ping();
    }
  }, config.HEARTBEAT_INTERVAL_MS);

  websocketServer.on(
    "close",
    () => {
      clearInterval(heartbeat);
    }
  );

  return websocketServer;
}

export function closeAllWebSockets(): void {
  for (const client of clients) {
    try {
      client.socket.close(
        1001,
        "Server shutting down"
      );
    } catch {
      // Ignore shutdown errors.
    }
  }

  clients.clear();
}
