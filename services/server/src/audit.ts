import { randomUUID } from "node:crypto";

import type {
  AuditEvent,
  AuditEventType,
  ParticipantRole,
  Session
} from "./types.js";

export function addAuditEvent(
  session: Session,
  type: AuditEventType,
  role?: ParticipantRole,
  metadata?: Record<string, unknown>
): AuditEvent {
  const event: AuditEvent = {
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    role,
    metadata
  };

  session.audit.push(event);
  session.updatedAt = event.timestamp;

  return event;
}
