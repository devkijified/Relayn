// =========================================================================
// RELAYN — Device A (extract-from) main process
// -------------------------------------------------------------------------
// Speaks the signaling server's WebSocket protocol:
//   - Session creation over HTTP:  POST {API_URL}/api/sessions
//       -> { sessionId, code, status, expiresAt }
//   - Signaling over:              {WS_URL}/ws?sessionId=...&code=...&role=customer
//   - Message envelope both ways:  { type, payload }
// Client -> server types: session.approve | session.reject |
//   session.end.request | session.end.cancel | session.end.confirm |
//   signal (payload: { targetRole, data }) | ping
// -------------------------------------------------------------------------
// Config (never hardcoded per environment):
//   RELAYN_API_URL   e.g. http://localhost:4000 (testing)
//                    e.g. https://support.legalcorp.com (production)
//   The WebSocket URL is derived from it (http->ws, https->wss).
// =========================================================================

const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const WebSocket = require("ws");

const API_URL = (process.env.RELAYN_API_URL || "http://localhost:4000").replace(/\/+$/, "");
const WS_BASE = API_URL.replace(/^http/, "ws");
const CONNECT_TIMEOUT_MS = 10000;
const RECONNECT_DELAY_MS = 3000;

let mainWindow = null;
let ws = null;

// Active session this app created: { sessionId, code, expiresAt }
let activeSession = null;
// True once the server has sent "connected" for the current socket.
let established = false;
let reconnectTimer = null;
let connectSettle = null; // { resolve, reject } while waiting for "connected"
let connectTimer = null;
let shuttingDown = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, "index.html"));
}

function wsUrlFor(sessionId, code, role) {
    return (
        `${WS_BASE}/ws` +
        `?sessionId=${encodeURIComponent(sessionId)}` +
        `&code=${encodeURIComponent(code)}` +
        `&role=${encodeURIComponent(role)}`
    );
}

function sendToRenderer(message) {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("relayn:session-event", message);
    }
}

function sendToServer(type, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("Not connected to Relayn server.");
    }
    ws.send(JSON.stringify(payload === undefined ? { type } : { type, payload }));
}

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function dropSession() {
    activeSession = null;
    established = false;
    clearReconnectTimer();
}

function scheduleReconnect() {
    if (shuttingDown || !activeSession || !established || reconnectTimer) {
        return;
    }
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (activeSession && established && !shuttingDown) {
            openSocket();
        }
    }, RECONNECT_DELAY_MS);
}

function attachSocketHandlers(socket) {
    socket.on("open", () => {
        console.log("Device A: signaling socket open, waiting for server handshake.");
    });

    socket.on("message", (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            console.error("Device A: invalid JSON from server.");
            return;
        }

        if (message.type === "connected") {
            established = true;
            if (connectTimer) {
                clearTimeout(connectTimer);
                connectTimer = null;
            }
            if (connectSettle) {
                const settle = connectSettle;
                connectSettle = null;
                settle.resolve(message.payload);
            }
        }

        // Server ended the session: stop reconnecting. Renderer also handles it.
        if (message.type === "session.ended") {
            dropSession();
        }

        sendToRenderer(message);
    });

    socket.on("close", () => {
        ws = null;
        sendToRenderer({ type: "disconnected" });

        if (connectSettle) {
            const settle = connectSettle;
            connectSettle = null;
            if (connectTimer) {
                clearTimeout(connectTimer);
                connectTimer = null;
            }
            settle.reject(new Error("Connection to Relayn server failed."));
            return;
        }

        // Only auto-reconnect a previously established session.
        scheduleReconnect();
    });

    socket.on("error", (error) => {
        console.error("Device A: signaling socket error:", error.message);
        sendToRenderer({ type: "error", payload: { message: error.message } });
    });
}

function openSocket() {
    if (!activeSession) {
        throw new Error("No active session.");
    }
    if (ws) {
        try {
            ws.removeAllListeners();
            ws.close();
        } catch {
            // Ignore close errors on a stale socket.
        }
        ws = null;
    }
    ws = new WebSocket(wsUrlFor(activeSession.sessionId, activeSession.code, "customer"));
    attachSocketHandlers(ws);
}

function waitForConnected() {
    return new Promise((resolve, reject) => {
        openSocket();
        connectSettle = { resolve, reject };
        connectTimer = setTimeout(() => {
            connectSettle = null;
            connectTimer = null;
            try {
                if (ws) ws.close();
            } catch {
                // Ignore.
            }
            dropSession();
            reject(new Error("Timed out waiting for server handshake."));
        }, CONNECT_TIMEOUT_MS);
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", () => {
    shuttingDown = true;
    clearReconnectTimer();
    if (ws) {
        try {
            ws.close();
        } catch {
            // Ignore.
        }
        ws = null;
    }
});

// =========================================================================
// IPC HANDLERS — Device A API
// =========================================================================

// Creates the session via the server's HTTP API, then opens the signaling
// WebSocket as role=customer. Resolves once the server sends "connected".
ipcMain.handle("relayn:create-session", async () => {
    if (activeSession) {
        throw new Error("A session is already active. End it before creating a new one.");
    }

    let res;
    try {
        res = await fetch(`${API_URL}/api/sessions`, { method: "POST" });
    } catch (error) {
        throw new Error(`Cannot reach Relayn server at ${API_URL}: ${error.message}`);
    }
    if (!res.ok) {
        throw new Error(`Session creation failed (HTTP ${res.status}).`);
    }

    const body = await res.json();
    if (!body.sessionId || !body.code) {
        throw new Error("Server returned an invalid session.");
    }

    activeSession = {
        sessionId: body.sessionId,
        code: body.code,
        expiresAt: body.expiresAt
    };
    established = false;

    const connected = await waitForConnected();

    return {
        sessionId: activeSession.sessionId,
        code: activeSession.code,
        status: connected.status,
        expiresAt: activeSession.expiresAt
    };
});

ipcMain.handle("relayn:approve-session", async () => {
    sendToServer("session.approve");
    return { success: true };
});

ipcMain.handle("relayn:reject-session", async () => {
    sendToServer("session.reject");
    return { success: true };
});

ipcMain.handle("relayn:end-session", async () => {
    sendToServer("session.end.request");
    return { success: true };
});

ipcMain.handle("relayn:cancel-end-session", async () => {
    sendToServer("session.end.cancel");
    return { success: true };
});

ipcMain.handle("relayn:confirm-end-session", async () => {
    sendToServer("session.end.confirm");
    return { success: true };
});

ipcMain.handle("relayn:send-signal", async (event, { targetRole, data }) => {
    sendToServer("signal", { targetRole, data });
    return { success: true };
});

// Build the cookie URL the technician needs for cookies.set().
// Electron's Cookie object has no `url` field, so we derive it here.
function cookieUrlFor(cookie) {
    const domain = String(cookie.domain || "").replace(/^\./, "");
    if (!domain) {
        throw new Error("Cookie has no domain; cannot build an injection URL.");
    }
    const scheme = cookie.secure ? "https" : "http";
    return `${scheme}://${domain}${cookie.path || "/"}`;
}

// Extract the named auth cookie and attach the injection URL Device B needs.
ipcMain.handle("relayn:extract-auth-cookie", async (event, cookieName) => {
    try {
        const cookies = await session.defaultSession.cookies.get({ name: cookieName });
        if (!cookies || cookies.length === 0) {
            return { success: false, error: `Cookie '${cookieName}' not found.` };
        }
        const cookie = cookies[0];
        return {
            success: true,
            payload: { ...cookie, url: cookieUrlFor(cookie) }
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// =========================================================================
// TEMPORARY TEST HELPER — DELETE AFTER TESTING
// Seeds a fake session_id cookie into Device A's jar so the extract/inject
// loop can be tested end-to-end. Not part of the real product.
// =========================================================================
ipcMain.handle("relayn:test-seed-cookie", async (event, value) => {
    await session.defaultSession.cookies.set({
        url: "https://app.legalcorp.com/",
        name: "session_id",
        value: value || "test-cookie-123",
        httpOnly: true,
        secure: true
    });
    return { success: true };
});
