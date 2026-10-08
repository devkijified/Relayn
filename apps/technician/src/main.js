const {
    app,
    BrowserWindow,
    ipcMain
} = require("electron");

const path = require("path");
const WebSocket = require("ws");

const SERVER_URL =
    "http://localhost:4000";

let mainWindow = null;
let currentSession = null;
let socket = null;

function createWindow() {
    mainWindow =
        new BrowserWindow({
            width: 1000,
            height: 700,
            minWidth: 800,
            minHeight: 600,
            webPreferences: {
                preload: path.join(
                    __dirname,
                    "preload.js"
                ),
                contextIsolation: true,
                nodeIntegration: false
            }
        });

    mainWindow.loadFile(
        path.join(
            __dirname,
            "index.html"
        )
    );
}

function sendEvent(data) {
    if (!mainWindow) {
        return;
    }

    mainWindow.webContents.send(
        "session:event",
        data
    );
}

function sendSocketMessage(message) {
    if (
        !socket ||
        socket.readyState !==
            WebSocket.OPEN
    ) {
        return false;
    }

    socket.send(
        JSON.stringify(message)
    );

    return true;
}

function connectWebSocket(
    sessionId,
    code
) {
    if (socket) {
        try {
            socket.close();
        } catch {
            // Ignore close errors.
        }

        socket = null;
    }

    const wsUrl =
        `ws://localhost:4000/ws?sessionId=${encodeURIComponent(
            sessionId
        )}&code=${encodeURIComponent(
            code
        )}&role=technician`;

    socket =
        new WebSocket(wsUrl);

    socket.on("open", () => {
        sendEvent({
            type: "socket.connected"
        });
    });

    socket.on(
        "message",
        (data) => {
            try {
                const message =
                    JSON.parse(
                        data.toString()
                    );

                sendEvent(message);
            } catch {
                sendEvent({
                    type: "error",
                    payload: {
                        code: "INVALID_SERVER_MESSAGE",
                        message:
                            "Received an invalid message from the server."
                    }
                });
            }
        }
    );

    socket.on("close", () => {
        sendEvent({
            type: "socket.closed"
        });

        socket = null;
    });

    socket.on("error", (error) => {
        sendEvent({
            type: "error",
            payload: {
                code: "SOCKET_ERROR",
                message:
                    error?.message ??
                    "WebSocket connection error."
            }
        });
    });
}

ipcMain.handle(
    "session:join",
    async (_event, code) => {
        const normalizedCode =
            String(code ?? "")
                .trim();

        if (
            !/^\d{6}$/.test(
                normalizedCode
            )
        ) {
            throw new Error(
                "Session code must be 6 digits."
            );
        }

        const response =
            await fetch(
                `${SERVER_URL}/api/sessions/code/${encodeURIComponent(
                    normalizedCode
                )}`
            );

        const data =
            await response.json();

        if (!response.ok) {
            throw new Error(
                data?.message ??
                    "Unable to find session."
            );
        }

        currentSession = data;

        connectWebSocket(
            data.sessionId,
            data.code
        );

        return data;
    }
);

ipcMain.handle(
    "session:request",
    async () => {
        const sent =
            sendSocketMessage({
                type: "session.request"
            });

        return {
            sent
        };
    }
);

ipcMain.handle(
    "session:end",
    async () => {
        const sent =
            sendSocketMessage({
                type: "session.end.request"
            });

        return {
            sent
        };
    }
);

ipcMain.handle(
    "session:end:cancel",
    async () => {
        const sent =
            sendSocketMessage({
                type: "session.end.cancel"
            });

        return {
            sent
        };
    }
);

ipcMain.handle(
    "session:end:confirm",
    async () => {
        const sent =
            sendSocketMessage({
                type: "session.end.confirm"
            });

        return {
            sent
        };
    }
);

ipcMain.handle(
    "session:signal",
    async (
        _event,
        payload
    ) => {
        const sent =
            sendSocketMessage({
                type: "signal",
                payload
            });

        return {
            sent
        };
    }
);

app.whenReady().then(
    () => {
        createWindow();

        app.on(
            "activate",
            () => {
                if (
                    BrowserWindow.getAllWindows()
                        .length === 0
                ) {
                    createWindow();
                }
            }
        );
    }
);

app.on(
    "window-all-closed",
    () => {
        if (
            process.platform !==
            "darwin"
        ) {
            app.quit();
        }
    }
);

app.on(
    "before-quit",
    () => {
        if (socket) {
            try {
                socket.close();
            } catch {
                // Ignore close errors.
            }
        }
    }
);