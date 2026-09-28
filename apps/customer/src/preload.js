const {
    contextBridge,
    ipcRenderer
} = require("electron");

contextBridge.exposeInMainWorld(
    "relayn",
    {
        createSession: () =>
            ipcRenderer.invoke(
                "session:create"
            ),

        approveSession: () =>
            ipcRenderer.invoke(
                "session:approve"
            ),

        rejectSession: () =>
            ipcRenderer.invoke(
                "session:reject"
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
        // 🔒 DEVICE A (CUSTOMER): SECURE MIGRATION CHANNELS
        // =========================================================================

        /**
         * Pulls the targeted session cookie securely out of the main process storage vault.
         * @param {string} cookieName - The identifier name of the login token (e.g., "session_id")
         * @returns {Promise<{success: boolean, payload?: Object, error?: string}>} The target cookie parameters
         */
        extractAuthCookie: (cookieName) => 
            ipcRenderer.invoke(
                "session:cookie:extract", 
                cookieName
            )
        // =========================================================================
    }
);
