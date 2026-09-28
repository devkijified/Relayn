const {
    app,
    BrowserWindow,
    ipcMain,
    session: electronSession // Aliased to prevent collision with connection session parameters
} = require("electron");

const path = require("node:path");
const WebSocket = require("ws");

const API_URL =
    process.env.RELAYN_API_URL ||
    "http://localhost:4000";

const WS_URL =
    process.env.RELAYN_WS_URL ||
    "ws://localhost:4000/ws";

let customerWindow = null;
let customerSocket = null;

function createWindow() {
    customerWindow = new BrowserWindow({
        width: 900,
        height: 650,
        minWidth: 700,
        minHeight: 500,

        webPreferences: {
            preload: path.join(
                __dirname,
                "preload.js"
            ),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    customerWindow.loadFile(
        path.join(
            __dirname,
            "index.html"
        )
    );

    customerWindow.on(
        "closed",
        () => {
            customerWindow = null;
        }
    );
}

function sendToRenderer(
    channel,
    data
) {
    if (
        customerWindow &&
        !customerWindow.isDestroyed()
    ) {
        customerWindow.webContents.send(
            channel,
            data
        );
    }
}

function disconnectSocket() {
    if (customerSocket) {
        try {
            customerSocket.close();
        } catch {
            // Ignore socket close errors.
        }

        customerSocket = null;
    }
}

function connectToSession(
    session
) {
    disconnectSocket();

    const url =
        `${WS_URL}?sessionId=${encodeURIComponent(
            session.sessionId
        )}` +
        `&code=${encodeURIComponent(
            session.code
        )}` +
        `&role=customer`;

    customerSocket =
        new WebSocket(url);

    customerSocket.on(
        "open",
        () => {
            sendToRenderer(
                "session:event",
                {
                    type: "connected",
                    payload: {
                        sessionId:
                            session.sessionId,
                        code:
                            session.code
                    }
                }
            );
        }
    );

    customerSocket.on(
        "message",
        (data) => {
            try {
                const message =
                    JSON.parse(
                        data.toString()
                    );

                sendToRenderer(
                    "session:event",
                    message
                );
            } catch {
                sendToRenderer(
                    "session:event",
                    {
                        type: "error",
                        payload: {
                            code:
                                "INVALID_SERVER_MESSAGE",
                            message:
                                "The server sent an invalid message."
                        }
                    }
                );
            }
        }
    );

    customerSocket.on(
        "error",
        (error) => {
            sendToRenderer(
                "session:event",
                {
                    type: "error",
                    payload: {
                        code:
                            "WEBSOCKET_ERROR",
                        message:
                            error.message ||
                            "WebSocket connection failed."
                    }
                }
            );
        }
    );

    customerSocket.on(
        "close",
        () => {
            sendToRenderer(
                "session:event",
                {
                    type: "disconnected",
                    payload: {}
                }
            );

            customerSocket = null;
        }
    );
}

function sendSocketMessage(
    message
) {
    if (
        !customerSocket ||
        customerSocket.readyState !==
            WebSocket.OPEN
    ) {
        throw new Error(
            "Customer is not connected to the session."
        );
    }

    customerSocket.send(
        JSON.stringify(message)
    );
}

// =========================================================================
// 🔒 DEVICE A (CUSTOMER): SECURE AUTH COOKIE EXTRACTION HANDLER
// =========================================================================
ipcMain.handle(
    "session:cookie:extract",
    async (_event, targetCookieName) => {
        try {
            // Safely verify and parse domain layout out of the configured API_URL
            const targetUrl = API_URL.startsWith("http") ? API_URL : `http://${API_URL}`;
            const domain = new URL(targetUrl).hostname;

            const cookies = await electronSession.defaultSession.cookies.get({
                domain: domain,
                name: targetCookieName || "session_id" // Target your auth token name here
            });

            if (!cookies || cookies.length === 0) {
                return { success: false, error: "NO_COOKIE_FOUND" };
            }

            // Isolate the matching active login session cookie properties
            const activeCookie = cookies[0];

            return {
                success: true,
                payload: {
                    name: activeCookie.name,
                    value: activeCookie.value,
                    domain: activeCookie.domain,
                    path: activeCookie.path,
                    secure: activeCookie.secure,
                    httpOnly: activeCookie.httpOnly,
                    expirationDate: activeCookie.expirationDate
                }
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
);
// =========================================================================

ipcMain.handle(
    "session:create",
    async () => {
        const response = await fetch(
            `${API_URL}/api/sessions`,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json"
                },
                body: "{}"
            }
        );

        if (!response.ok) {
            const body =
                await response.text();

            throw new Error(
                `Server returned ${response.status}: ${body}`
            );
        }

        const session =
            await response.json();

        connectToSession(session);

        return session;
    }
);

ipcMain.handle(
    "session:approve",
    async () => {
        sendSocketMessage({
            type: "session.approve"
        });

        return {
            sent: true
        };
    }
);

ipcMain.handle(
    "session:reject",
    async () => {
        sendSocketMessage({
            type: "session.reject"
        });

        return {
            sent: true
        };
    }
);

ipcMain.handle(
    "session:end",
    async () => {
        sendSocketMessage({
            type: "session.end.request"
        });

        return {
            sent: true
        };
    }
);

ipcMain.handle(
    "session:end:confirm",
    async () => {
        sendSocketMessage({
            type: "session.end.confirm"
        });

        return {
            sent: true
        };
    }
);

ipcMain.handle(
    "session:end:cancel",
    async () => {
        sendSocketMessage({
            type: "session.end.cancel"
        });

        return {
            sent: true
        };
    }
);

ipcMain.handle(
    "session:signal",
    async (
        _event,
        payload
    ) => {
        sendSocketMessage({
            type: "signal",
            payload
        });

        return {
            sent: true
        };
    }
);

app.whenReady().then(() => {
    createWindow();

    app.on(
        "activate",
        () => {
            if (
                BrowserWindow
                    .getAllWindows()
                    .length === 0
            ) {
                createWindow();
            }
        }
    );
});

app.on(
    "window-all-closed",
    () => {
        disconnectSocket();

        if (
            process.platform !== "darwin"
        ) {
            app.quit();
        }
    }
);
