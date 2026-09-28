export type SessionStatus =
  | "WAITING_FOR_TECHNICIAN"
  | "TECHNICIAN_REQUESTED"
  | "CONNECTED"
  | "END_REQUESTED"
  | "ENDED"
  | "EXPIRED";

export type ParticipantRole = "customer" | "technician";

export type AuditEventType =
  | "SESSION_CREATED"
  | "TECHNICIAN_JOINED"
  | "TECHNICIAN_REQUESTED"
  | "CUSTOMER_APPROVED"
  | "CUSTOMER_REJECTED"
  | "SESSION_CONNECTED"
  | "END_REQUESTED"
  | "END_CONFIRMED"
  | "END_TIMEOUT"
  | "PARTICIPANT_DISCONNECTED"
  | "SESSION_ENDED"
  | "SESSION_EXPIRED";

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  timestamp: string;
  role?: ParticipantRole;
  metadata?: Record<string, unknown>;
}

export interface Participant {
  id: string;
  role: ParticipantRole;
  connected: boolean;
  connectedAt: string;
  lastSeenAt: string;
}

export interface Session {
  id: string;
  code: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;

  customer?: Participant;
  technician?: Participant;

  endRequestedAt?: string;
  endRequestedBy?: ParticipantRole;

  audit: AuditEvent[];
}

export interface CreateSessionResponse {
  sessionId: string;
  code: string;
  status: SessionStatus;
  expiresAt: string;
}

export interface WebSocketMessage {
  type: string;
  requestId?: string;
  payload?: unknown;
}

export interface SessionCreatedMessage {
  type: "session.created";
  payload: {
    sessionId: string;
    code: string;
  };
}

export interface SessionStateMessage {
  type: "session.state";
  payload: {
    sessionId: string;
    code: string;
    status: SessionStatus;
    customerConnected: boolean;
    technicianConnected: boolean;
    expiresAt: string;
  };
}

export interface ErrorMessage {
  type: "error";
  payload: {
    code: string;
    message: string;
  };
}
