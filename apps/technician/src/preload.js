// =========================================================================
// RELAYN — Device B (inject-to) preload script
// -------------------------------------------------------------------------
// Exposes ONLY the Device B API surface. Device A functions
// (createSession, approveSession, rejectSession, extractAuthCookie) are
// intentionally absent: the renderer cannot invoke IPC handlers that do
// not exist, which keeps each app's attack surface to what it actually
// needs.
// =========================================================================

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relayn", {
    // Session lifecycle (Device B joins via code)
    joinSession: (code) => ipcRenderer.invoke("relayn:join-session", code),
    requestAccess: () => ipcRenderer.invoke("relayn:request-access"),
    endSession: () => ipcRenderer.invoke("relayn:end-session"),
    cancelEndSession: () => ipcRenderer.invoke("relayn:cancel-end-session"),
    confirmEndSession: () => ipcRenderer.invoke("relayn:confirm-end-session"),

    // WebRTC signaling relay (payload: { targetRole, data })
    sendSignal: (targetRole, data) =>
        ipcRenderer.invoke("relayn:send-signal", { targetRole, data }),

    // Cookie injection / removal (Device B only — never extraction)
    injectAuthCookie: (cookieData) =>
        ipcRenderer.invoke("relayn:inject-auth-cookie", cookieData),
    removeAuthCookie: () =>
        ipcRenderer.invoke("relayn:remove-auth-cookie"),

    // Server event subscription. Re-subscribing replaces the old listener
    // so renderer reloads can't stack duplicate handlers.
    onSessionEvent: (callback) => {
        ipcRenderer.removeAllListeners("relayn:session-event");
        ipcRenderer.on("relayn:session-event", (event, message) => callback(message));
    }
});
