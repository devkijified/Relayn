const {
    contextBridge,
    ipcRenderer
} = require("electron");

contextBridge.exposeInMainWorld(
    "relayn",
    {
        joinSession: (code) =>
            ipcRenderer.invoke(
                "session:join",
                code
            ),

        requestAccess: () =>
            ipcRenderer.invoke(
                "session:request"
            ),

        endSession: () =>
            ipcRenderer.invoke(
                "session:end"
            ),

        cancelEndSession: () =>
            ipcRenderer.invoke(
                "session:end:cancel"
            ),

        confirmEndSession: () =>
            ipcRenderer.invoke(
                "session:end:confirm"
            ),

        sendSignal: (
            targetRole,
            data
        ) =>
            ipcRenderer.invoke(
                "session:signal",
                {
                    targetRole,
                    data
                }
            ),

        onSessionEvent: (
            callback
        ) => {
            const listener = (
                _event,
                data
            ) => {
                callback(data);
            };

            ipcRenderer.on(
                "session:event",
                listener
            );

            return () => {
                ipcRenderer.removeListener(
                    "session:event",
                    listener
                );
            };
        },

        // =========================================================================
        // 🔒 DEVICE B (TECHNICIAN): SECURE MIGRATION CHANNELS
        // =========================================================================

        /**
         * Injects a raw session cookie structure directly into the app's sandboxed storage.
         * @param {Object} cookieData - The full cookie structure object transferred over WebRTC
         * @returns {Promise<{success: boolean, error?: string}>} Resolves with status of the operation
         */
        injectAuthCookie: (cookieData) => 
            ipcRenderer.invoke(
                "session:cookie:inject", 
                cookieData
            )
        // =========================================================================
    }
);
