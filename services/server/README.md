# Relayn Server

Relayn's signaling and session-management server.

## Responsibilities

The Phase 1 server handles:

- Session creation
- Session codes
- Customer/technician roles
- Customer approval
- Session lifecycle
- WebSocket signaling
- End-session handshake
- 90-second end-session timeout
- Heartbeats
- Audit events
- Session expiration

## Development

From the repository root:

```bash
pnpm install
