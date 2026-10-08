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
        }
    }
);