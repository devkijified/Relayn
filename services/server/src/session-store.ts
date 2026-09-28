import { randomInt, randomUUID } from "node:crypto";

import { addAuditEvent } from "./audit.js";
import { config } from "./config.js";
import type {
  Participant,
  ParticipantRole,
  Session,
  SessionStatus
} from "./types.js";

const CODE_ALPHABET = "0123456789";

function generateCode(length: number): string {
  let code = "";

  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }

  return code;
}

function createUniqueCode(
  sessions: Map<string, Session>
): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = generateCode(config.SESSION_CODE_LENGTH);

    const exists = [...sessions.values()].some(
      (session) =>
        session.code === code &&
        session.status !== "ENDED" &&
        session.status !== "EXPIRED"
    );

    if (!exists) {
      return code;
    }
  }

  throw new Error("Unable to generate a unique session code");
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  createSession(): Session {
    const now = new Date();
    const createdAt = now.toISOString();

    const expiresAt = new Date(
      now.getTime() + config.SESSION_TTL_MS
    ).toISOString();

    const session: Session = {
      id: randomUUID(),
      code: createUniqueCode(this.sessions),
      status: "WAITING_FOR_TECHNICIAN",
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      audit: []
    };

    addAuditEvent(session, "SESSION_CREATED");

    this.sessions.set(session.id, session);

    return session;
  }

  getById(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getByCode(code: string): Session | undefined {
    const normalizedCode = code.trim();

    return [...this.sessions.values()].find(
      (session) =>
        session.code === normalizedCode &&
        session.status !== "ENDED" &&
        session.status !== "EXPIRED"
    );
  }

  addParticipant(
    session: Session,
    role: ParticipantRole
  ): Participant {
    const now = new Date().toISOString();

    const participant: Participant = {
      id: randomUUID(),
      role,
      connected: true,
      connectedAt: now,
      lastSeenAt: now
    };

    if (role === "customer") {
      session.customer = participant;
    } else {
      session.technician = participant;
    }

    session.updatedAt = now;

    return participant;
  }

  removeParticipant(
    session: Session,
    role: ParticipantRole
  ): void {
    const participant =
      role === "customer"
        ? session.customer
        : session.technician;

    if (!participant) {
      return;
    }

    participant.connected = false;
    participant.lastSeenAt = new Date().toISOString();

    session.updatedAt = participant.lastSeenAt;
  }

  touchParticipant(
    session: Session,
    role: ParticipantRole
  ): void {
    const participant =
      role === "customer"
        ? session.customer
        : session.technician;

    if (!participant) {
      return;
    }

    participant.lastSeenAt = new Date().toISOString();
    session.updatedAt = participant.lastSeenAt;
  }

  setStatus(
    session: Session,
    status: SessionStatus
  ): void {
    session.status = status;
    session.updatedAt = new Date().toISOString();
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  cleanupExpired(): Session[] {
    const now = Date.now();
    const expired: Session[] = [];

    for (const session of this.sessions.values()) {
      if (
        session.status === "ENDED" ||
        session.status === "EXPIRED"
      ) {
        continue;
      }

      if (Date.parse(session.expiresAt) <= now) {
        this.setStatus(session, "EXPIRED");

        addAuditEvent(
          session,
          "SESSION_EXPIRED"
        );

        expired.push(session);
      }
    }

    return expired;
  }
}
