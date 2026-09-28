# Relayn

Relayn is an in-house remote-support platform with a customer Electron app, technician console, signaling/API server, and a future WebRTC desktop-control layer.

## Current milestone

Phase 1 provides:

- Customer support-session creation with a 6-digit code.
- Explicit customer consent before remote-control authorization is sent to the technician.
- Technician session joining.
- WebSocket signaling relay suitable for the next WebRTC phase.
- Two-party end-session confirmation with a 90-second timeout fallback.
- Basic server-side audit logging.

The desktop streaming/input-control layer is intentionally the next milestone.

## Requirements

- Node.js 20+
- pnpm 10+

## Install

```bash
pnpm install
```

## Run server

```bash
pnpm dev:server
```

Server: `ws://localhost:8787/ws`
Health: `http://localhost:8787/health`

## Run customer

```bash
pnpm start:customer
```

## Run technician

In another terminal:

```bash
pnpm start:technician
```

Create a session in Customer, copy the 6-digit code, and enter it in the Technician console. The customer must explicitly approve the session.

## Environment

Copy `.env.example` to `.env` for deployment-specific values. Never commit secrets.
