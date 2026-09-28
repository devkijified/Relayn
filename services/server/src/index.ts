import Fastify from 'fastify';
import cors from '@fastify/cors';
import { WebSocketServer, WebSocket } from 'ws';
import { randomInt, randomUUID } from 'node:crypto';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

type Role = 'customer' | 'technician';
type Session = {
  id: string; code: string; customer?: WebSocket; technician?: WebSocket;
  endRequest?: { requestedBy: Role; expiresAt: number };
};
const sessions = new Map<string, Session>();
const codes = new Map<string, string>();

function code() {
  let c = '';
  do c = String(randomInt(100000, 1000000)); while (codes.has(c));
  return c;
}
function send(ws: WebSocket | undefined, type: string, data: unknown = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data as object }));
}
function audit(s: Session, event: string, role?: Role) {
  app.log.info({ sessionId: s.id, event, role }, 'audit');
}

app.get('/health', async () => ({ ok: true, service: 'remote-support-server' }));

const server = await app.listen({ port: Number(process.env.PORT ?? 8787), host: '0.0.0.0' });
const wss = new WebSocketServer({ server: app.server, path: '/ws' });

wss.on('connection', (ws) => {
  let session: Session | undefined;
  let role: Role | undefined;

  ws.on('message', raw => {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return send(ws, 'error', { message: 'Invalid JSON' }); }

    if (msg.type === 'create_session' && msg.role === 'customer') {
      const c = code();
      session = { id: randomUUID(), code: c, customer: ws };
      sessions.set(session.id, session); codes.set(c, session.id); role = 'customer';
      audit(session, 'session_created', role);
      return send(ws, 'session_created', { sessionId: session.id, code: c });
    }

    if (msg.type === 'join_session' && msg.role === 'technician') {
      const id = codes.get(String(msg.code));
      session = id ? sessions.get(id) : undefined;
      if (!session || session.technician) return send(ws, 'error', { message: 'Session unavailable' });
      session.technician = ws; role = 'technician';
      audit(session, 'technician_joined', role);
      send(ws, 'joined', { sessionId: session.id });
      send(session.customer, 'technician_joined');
      return;
    }

    if (!session || !role) return send(ws, 'error', { message: 'Join a session first' });

    if (msg.type === 'consent_granted' && role === 'customer') {
      audit(session, 'customer_consent_granted', role);
      send(session.technician, 'consent_granted');
      return;
    }

    // WebRTC signaling is intentionally generic: SDP/ICE payloads are relayed, not inspected.
    if (msg.type === 'signal') {
      send(role === 'customer' ? session.technician : session.customer, 'signal', { payload: msg.payload });
      return;
    }

    if (msg.type === 'request_end') {
      session.endRequest = { requestedBy: role, expiresAt: Date.now() + 90_000 };
      const other = role === 'customer' ? session.technician : session.customer;
      audit(session, 'end_requested', role);
      send(other, 'end_confirmation_required', { requestedBy: role, timeoutMs: 90_000 });
      return;
    }

    if (msg.type === 'confirm_end') {
      audit(session, 'session_ended', role);
      send(session.customer, 'session_ended', { reason: 'confirmed' });
      send(session.technician, 'session_ended', { reason: 'confirmed' });
      codes.delete(session.code); sessions.delete(session.id);
      return;
    }

    if (msg.type === 'reject_end') {
      session.endRequest = undefined;
      audit(session, 'end_rejected', role);
      send(role === 'customer' ? session.technician : session.customer, 'end_rejected');
      return;
    }
  });

  ws.on('close', () => {
    if (!session || !role) return;
    const other = role === 'customer' ? session.technician : session.customer;
    send(other, 'peer_disconnected');
    audit(session, 'peer_disconnected', role);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.endRequest && s.endRequest.expiresAt <= now) {
      audit(s, 'session_force_ended', s.endRequest.requestedBy);
      send(s.customer, 'session_ended', { reason: 'timeout' });
      send(s.technician, 'session_ended', { reason: 'timeout' });
      codes.delete(s.code); sessions.delete(s.id);
    }
  }
}, 1000);

console.log(`Remote Support server listening at ${server}`);
