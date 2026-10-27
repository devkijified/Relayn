# Relayn — Chrome Extension (MV3)

Move your logins from one device to another. No accounts, no codes to type,
no simultaneous online time.

## How it works

**Device A — "📤 Share this device"** (the browser that's already logged in)

1. Reads its whole cookie jar.
2. Encrypts it with a fresh random 256-bit AES-GCM key.
3. Uploads the *ciphertext* to your cloud server (`POST /api/share`).
4. Shows a QR code containing `{ v: 2, server, id, key }`.

**Device B — "📷 Scan QR code"**

1. Scans the QR with the camera.
2. Adopts the server address from the QR — nothing to type or paste.
3. Downloads the ciphertext once (`GET /api/share/:id` — single-use, then deleted).
4. Decrypts locally with the QR key and imports everything automatically.
5. "Done! You're logged in."

The server only ever holds ciphertext: the encryption key travels inside the
QR code (camera = out-of-band key exchange) and never touches the server.
Shares are single-use and expire after 10 minutes.

## Assigned accounts (admin + child)

Set the same `"account": { "id": "…" }` in `config.json` on both builds and
shares change shape:

- Device A uploads the **full share — ciphertext AND the decryption key** —
  tagged with the account ID. The server stores it for **48 hours**
  (`ACCOUNT_SHARE_TTL_MS`) and it is **multi-use** within that window.
- The admin build (`"features": { "inbox": true }`) shows an **incoming
  shares** list: one tap imports everything, no QR scan needed.
- This is a deliberate trade-off: the server operator can technically read
  account shares. Possession of the account ID is the authorization
  (same model as the backup ID + passphrase).
- With the account ID empty, shares stay anonymous: single-use, 10-minute
  expiry, server never sees the key.

## Files

- `manifest.json` — MV3 manifest (`cookies` + `storage` + `unlimitedStorage`).
- `config.json` — whitelabel config: extension name, tagline, bio, theme
  colour, server URL and feature flags (`share` / `scan` / `serverCard`).
  Edit it and reload the extension — no code changes needed.
- `background.js` — service worker. Owns the share upload/download, all
  WebCrypto work, and all cookie extract/inject via the `chrome.cookies` API.
  All state lives here so closing the popup never loses a staged import.
  Reads its server URL from `config.json`.
- `popup.html` / `popup.js` — thin UI. Sends actions, renders the state
  snapshot from the service worker. Includes the camera QR scanner
  (vendored `jsQR`) and the QR renderer (vendored `qrcodejs`).
- `vendor/` — vendored `qrcode.min.js` + `jsQR.min.js` (no CDN dependency).
- `server/` — the cloud server (Fastify): `POST /api/share`,
  `GET /api/share/:id`, plus the durable encrypted backups
  (`POST/GET/DELETE /api/backups`) and the account-share endpoints
  (`GET /api/account/:accountId/shares`,
  `GET /api/account/:accountId/shares/:shareId`).

## Try it locally

1. `pnpm install && pnpm dev` in `server/` (listens on `http://localhost:4000`).
2. Point the extension at it: set `"server": { "url": "http://localhost:4000" }`
   in `config.json`.
3. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
4. Device A: **Share this device** → QR appears. Device B (second Chrome
   profile): **Scan QR code** → point at the QR (or upload its image).

## Deploying the server

The server is a plain Node app with a Dockerfile. Push the repo to GitHub and
use `render.yaml` (Render Blueprint) — or any host that runs Docker / Node 20:

- Set `TRUST_PROXY=true` behind the host's proxy.
- `PORT` is injected by the host.
- No secrets needed: there are no API keys in this design. (The old Cloudflare
  TURN integration is gone — there is no WebRTC any more.)

After deploy, set the public URL once in `config.json`
(`"server": { "url": "https://…" }`) before packaging.
Device B never needs it — the QR carries the address.

## Packaging

Zip the extension flat (manifest.json at the zip root):

```
zip relayn-extension.zip manifest.json background.js popup.html popup.js config.json README.md vendor/qrcode.min.js vendor/jsQR.min.js
```
