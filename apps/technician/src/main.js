// =========================================================================
// RELAYN — Device B (inject-to) main process
// -------------------------------------------------------------------------
// Speaks the signaling server's WebSocket protocol:
//   - Session join over HTTP:     POST {API_URL}/api/sessions/join { code }
//       -> { sessionId, code, status, expiresAt }
//   - Signaling over:             {WS_URL}/ws?sessionId=...&code=...&role=technician
//   - Message envelope both ways: { type, payload }
// Client -> server types: session.request | session.end.request |
//   session.end.cancel | session.end.confirm |
//   signal (payload: { targetRole, data }) | ping
// -------------------------------------------------------------------------
// Injected-cookie lifecycle: the cookie received from Device A is tracked
// and REMOVED when the session ends or the app quits, so no foreign
// session persists in this device's cookie jar afterwards.
// -------------------------------------------------------------------------
// Config (never hardcoded per environment):
//   RELAYN_API_URL   e.g. http://localhost:4000 (testing)
//                    e.g. https://support.legalcorp.com (production)
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

// Active joined session: { sessionId, code, expiresAt }
let activeSession = null;
let established = false;
let reconnectTimer = null;
let connectSettle = null;
let connectTimer = null;
let shuttingDown = false;

// The cookie currently injected from Device A: { url, name } | null
let injectedCookie = null;

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
        console.log("Device B: signaling socket open, waiting for server handshake.");
    });

    socket.on("message", (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            console.error("Device B: invalid JSON from server.");
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

        if (message.type === "session.ended") {
            // Session over: remove the injected cookie first, then drop state.
            removeInjectedCookie().finally(() => dropSession());
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

        scheduleReconnect();
    });

    socket.on("error", (error) => {
        console.error("Device B: signaling socket error:", error.message);
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
    ws = new WebSocket(wsUrlFor(activeSession.sessionId, activeSession.code, "technician"));
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

app.on("before-quit", async () => {
    shuttingDown = true;
    clearReconnectTimer();
    await removeInjectedCookie();
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
// IPC HANDLERS — Device B API
// =========================================================================

// Resolve the 6-digit code to a session via HTTP, then open the signaling
// WebSocket as role=technician. Resolves once the server sends "connected".
ipcMain.handle("relayn:join-session", async (event, code) => {
    if (activeSession) {
        throw new Error("A session is already active. End it before joining a new one.");
    }

    const cleanCode = String(code || "").trim();
    if (!/^\d{4,10}$/.test(cleanCode)) {
        throw new Error("Please enter a valid support code.");
    }

    let res;
    try {
        res = await fetch(`${API_URL}/api/sessions/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: cleanCode })
        });
    } catch (error) {
        throw new Error(`Cannot reach Relayn server at ${API_URL}: ${error.message}`);
    }
    if (res.status === 404) {
        throw new Error("No active session matches that code.");
    }
    if (res.status === 429) {
        throw new Error("Too many attempts. Please wait and try again.");
    }
    if (!res.ok) {
        throw new Error(`Join failed (HTTP ${res.status}).`);
    }

    const body = await res.json();
    if (!body.sessionId) {
        throw new Error("Server returned an invalid session.");
    }

    activeSession = {
        sessionId: body.sessionId,
        code: body.code || cleanCode,
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

ipcMain.handle("relayn:request-access", async () => {
    sendToServer("session.request");
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

// -------------------------------------------------------------------------
// Cookie injection / removal
// -------------------------------------------------------------------------

function cookieUrlFor(cookie) {
    if (cookie.url && /^https?:\/\//.test(cookie.url)) {
        return cookie.url;
    }
    const domain = String(cookie.domain || "").replace(/^\./, "");
    if (!domain) {
        throw new Error("Cookie has no domain; cannot build an injection URL.");
    }
    const scheme = cookie.secure ? "https" : "http";
    return `${scheme}://${domain}${cookie.path || "/"}`;
}

ipcMain.handle("relayn:inject-auth-cookie", async (event, cookieData) => {
    try {
        if (!cookieData || !cookieData.name) {
            return { success: false, error: "Invalid cookie payload received." };
        }

        const url = cookieUrlFor(cookieData);

        await session.defaultSession.cookies.set({
            url,
            name: cookieData.name,
            value: cookieData.value || "",
            domain: cookieData.domain,
            path: cookieData.path || "/",
            secure: Boolean(cookieData.secure),
            httpOnly: Boolean(cookieData.httpOnly),
            ...(cookieData.expirationDate
                ? { expirationDate: cookieData.expirationDate }
                : {})
        });

        // Track it so it can be removed when the session ends.
        injectedCookie = { url, name: cookieData.name };

        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

async function removeInjectedCookie() {
    if (!injectedCookie) {
        return;
    }
    const { url, name } = injectedCookie;
    injectedCookie = null;
    try {
        await session.defaultSession.cookies.remove(url, name);
        console.log("Device B: injected cookie removed after session end.");
    } catch (error) {
        console.error("Device B: failed to remove injected cookie:", error.message);
    }
}

ipcMain.handle("relayn:remove-auth-cookie", async () => {
    await removeInjectedCookie();
    return { success: true };
});
