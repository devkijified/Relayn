// =========================================================================
// RELAYN — Device A (extract-from) preload script
// -------------------------------------------------------------------------
// Exposes ONLY the Device A API surface. Device B functions
// (joinSession, requestAccess, injectAuthCookie) are intentionally absent:
// the renderer cannot invoke IPC handlers that do not exist, which keeps
// each app's attack surface to what it actually needs.
//
// NOTE: seedTestCookie is a TEMPORARY test helper — remove it (and the
// matching main-process handler) after testing.
// =========================================================================

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relayn", {
    // Session lifecycle (Device A creates the session)
    createSession: () => ipcRenderer.invoke("relayn:create-session"),
    approveSession: () => ipcRenderer.invoke("relayn:approve-session"),
    rejectSession: () => ipcRenderer.invoke("relayn:reject-session"),
    endSession: () => ipcRenderer.invoke("relayn:end-session"),
    cancelEndSession: () => ipcRenderer.invoke("relayn:cancel-end-session"),
    confirmEndSession: () => ipcRenderer.invoke("relayn:confirm-end-session"),

    // WebRTC signaling relay (payload: { targetRole, data })
    sendSignal: (targetRole, data) =>
        ipcRenderer.invoke("relayn:send-signal", { targetRole, data }),

    // Cookie extraction (Device A only — never injection)
    extractAuthCookie: (cookieName) =>
        ipcRenderer.invoke("relayn:extract-auth-cookie", cookieName),

    // TEMPORARY test helper — DELETE AFTER TESTING
    seedTestCookie: (value) =>
        ipcRenderer.invoke("relayn:test-seed-cookie", value),

    // Server event subscription. Re-subscribing replaces the old listener
    // so renderer reloads can't stack duplicate handlers.
    onSessionEvent: (callback) => {
        ipcRenderer.removeAllListeners("relayn:session-event");
        ipcRenderer.on("relayn:session-event", (event, message) => callback(message));
    }
});
