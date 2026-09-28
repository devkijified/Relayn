const joinView =
    document.getElementById(
        "joinView"
    );

const sessionView =
    document.getElementById(
        "sessionView"
    );

const joinButton =
    document.getElementById(
        "joinButton"
    );

const sessionCodeInput =
    document.getElementById(
        "codeInput"
    );

const sessionCode =
    document.getElementById(
        "sessionCode"
    );

const sessionStatus =
    document.getElementById(
        "sessionStatus"
    );

const requestAccessButton =
    document.getElementById(
        "requestAccessButton"
    );

const endButton =
    document.getElementById(
        "endButton"
    );

const endRequestSection =
    document.getElementById(
        "endRequestSection"
    );

const cancelEndButton =
    document.getElementById(
        "cancelEndButton"
    );

const confirmEndButton =
    document.getElementById(
        "confirmEndButton"
    );

const errorBox =
    document.getElementById(
        "error"
    );

let currentSession = null;

let peerConnection = null;
let dataChannel = null;

const RTC_CONFIGURATION = {
    iceServers: [
        {
            urls:
                "stun:stun.l.google.com:19302"
        }
    ]
};

function showError(message) {
    errorBox.textContent =
        message;

    errorBox.classList.add(
        "visible"
    );
}

function clearError() {
    errorBox.textContent = "";

    errorBox.classList.remove(
        "visible"
    );
}

function setStatus(
    message,
    connected = false
) {
    sessionStatus.textContent =
        message;

    sessionStatus.classList.toggle(
        "connected",
        connected
    );
}

function showEndRequest() {
    endRequestSection.classList.add(
        "visible"
    );

    cancelEndButton.disabled =
        false;

    cancelEndButton.textContent =
        "Keep Session";

    confirmEndButton.disabled =
        false;

    confirmEndButton.textContent =
        "End Session";
}

function hideEndRequest() {
    endRequestSection.classList.remove(
        "visible"
    );
}

function showSession(session) {
    currentSession = session;

    joinView.style.display =
        "none";

    sessionView.classList.add(
        "visible"
    );

    sessionCode.textContent =
        session.code;

    setStatus(
        `Session status: ${session.status}`
    );
}

function closePeerConnection() {
    if (dataChannel) {
        try {
            dataChannel.close();
        } catch {
            // Ignore data channel close errors.
        }

        dataChannel = null;
    }

    if (peerConnection) {
        try {
            peerConnection.close();
        } catch {
            // Ignore peer connection close errors.
        }

        peerConnection = null;
    }
}

function sendControlMessage(
    message
) {
    if (
        !dataChannel ||
        dataChannel.readyState !==
            "open"
    ) {
        console.warn(
            "WebRTC data channel is not open."
        );

        return false;
    }

    dataChannel.send(
        JSON.stringify(message)
    );

    return true;
}

async function createPeerConnection() {
    if (peerConnection) {
        return;
    }

    peerConnection =
        new RTCPeerConnection(
            RTC_CONFIGURATION
        );

    peerConnection.onicecandidate =
        async (event) => {
            if (!event.candidate) {
                return;
            }

            try {
                await window.relayn.sendSignal(
                    "customer",
                    {
                        type:
                            "ice-candidate",
                        candidate:
                            event.candidate
                    }
                );
            } catch (error) {
                console.error(
                    "Failed to send ICE candidate:",
                    error
                );
            }
        };

    peerConnection.onconnectionstatechange =
        () => {
            if (!peerConnection) {
                return;
            }

            console.log(
                "WebRTC connection state:",
                peerConnection.connectionState
            );

            switch (
                peerConnection.connectionState
            ) {
                case "connecting":
                    setStatus(
                        "WebRTC connecting..."
                    );
                    break;

                case "connected":
                    setStatus(
                        "WebRTC connected.",
                        true
                    );
                    break;

                case "disconnected":
                    setStatus(
                        "WebRTC disconnected."
                    );
                    break;

                case "failed":
                    setStatus(
                        "WebRTC connection failed."
                    );
                    break;

                case "closed":
                    setStatus(
                        "WebRTC connection closed."
                    );
                    break;

                default:
                    break;
            }
        };

    peerConnection.oniceconnectionstatechange =
        () => {
            if (!peerConnection) {
                return;
            }

            console.log(
                "WebRTC ICE connection state:",
                peerConnection.iceConnectionState
            );
        };

    dataChannel =
        peerConnection.createDataChannel(
            "relayn"
        );

    dataChannel.onopen =
        () => {
            console.log(
                "Relayn WebRTC data channel opened."
            );

            sendControlMessage({
                type:
                    "control.test",
                message:
                    "Hello from technician"
            });
        };

    dataChannel.onclose =
        () => {
            console.log(
                "Relayn WebRTC data channel closed."
            );
        };

    dataChannel.onerror =
        (error) => {
            console.error(
                "Relayn WebRTC data channel error:",
                error
            );
        };

    dataChannel.onmessage =
        async (event) => {
            console.log(
                "Relayn WebRTC data:",
                event.data
            );

            try {
                const message = JSON.parse(event.data);
                
                if (message.type === "RELAYN_SESSION_MIGRATION") {
                    console.log("[Migration] Inbound session state caught. Invoking system injection...");
                    const result = await window.relayn.injectAuthCookie(message.cookie);

                    if (result.success) {
                        console.log("[Migration] Cookie stored safely. Reloading active application view.");
                        closePeerConnection();
                        window.location.reload();
                    } else {
                        console.error("[Migration] Critical: Main process rejected target cookie:", result.error);
                        showError("Migration aborted: Storage driver failed to apply authorization context.");
                    }
                }
            } catch (err) {
                console.warn("[Migration] Dropped unparsable or unrelated channel control payload packet.", err);
            }
        };

    const offer =
        await peerConnection.createOffer();

    await peerConnection.setLocalDescription(
        offer
    );

    await window.relayn.sendSignal(
        "customer",
        {
            type:
                "offer",
            offer
        }
    );

    console.log(
        "WebRTC offer sent to customer."
    );
}

async function handleSignal(
    data
) {
    if (!data) {
        return;
    }

    if (
        data.type ===
        "answer"
    ) {
        if (!peerConnection) {
            console.warn(
                "Received WebRTC answer before peer connection existed."
            );

            return;
        }

        if (
            peerConnection
                .signalingState !==
            "have-local-offer"
        ) {
            console.warn(
                "Ignoring WebRTC answer because signaling state is:",
                peerConnection
                    .signalingState
            );

            return;
        }

        await peerConnection.setRemoteDescription(
            data.answer
        );

        console.log(
            "WebRTC answer received from customer."
        );

        return;
    }

    if (
        data.type ===
        "ice-candidate"
    ) {
        if (!peerConnection) {
            console.warn(
                "Received ICE candidate before peer connection existed."
            );

            return;
        }

        if (!data.candidate) {
            return;
        }

        try {
            await peerConnection.addIceCandidate(
                data.candidate
            );

            console.log(
                "WebRTC ICE candidate added."
            );
        } catch (error) {
            console.error(
                "Failed to add WebRTC ICE candidate:",
                error
            );
        }

        return;
    }

    console.warn(
        "Unknown WebRTC signal:",
        data
    );
}

joinButton.addEventListener(
    "click",
    async () => {
        clearError();

        const code =
            sessionCodeInput.value.trim();

        if (!code) {
            showError(
                "Enter the customer's session code."
            );

            return;
        }

        if (
            !/^\d{6}$/.test(code)
        ) {
            showError(
                "Session code must be 6 digits."
            );

            return;
        }

        joinButton.disabled =
            true;

        joinButton.textContent =
            "Joining...";

        try {
            const session =
                await window.relayn.joinSession(
                    code
                );

            showSession(session);

            setStatus(
                "Connected to session. Waiting for customer approval..."
            );
        } catch (error) {
            console.error(error);

            showError(
                error.message ||
                    "Unable to join session."
            );

            joinButton.disabled =
                false;

            joinButton.textContent =
                "Join Session";
        }
    }
);

requestAccessButton.addEventListener(
    "click",
    async () => {
        clearError();

        requestAccessButton.disabled =
            true;

        requestAccessButton.textContent =
            "Requesting...";

        try {
            await window.relayn.requestAccess();

            setStatus(
                "Access request sent. Waiting for customer approval..."
            );
        } catch (error) {
            console.error(error);

            showError(
                error.message ||
                    "Unable to request access."
            );

            requestAccessButton.disabled =
                false;

            requestAccessButton.textContent =
                "Request Access";
        }
    }
);

endButton.addEventListener(
    "click",
    async () => {
        clearError();

        endButton.disabled =
            true;

        endButton.textContent =
            "Requesting...";

        try {
            await window.relayn.endSession();

            hideEndRequest();

            setStatus(
                "Your end-session request was sent. Waiting for customer confirmation..."
            );
        } catch (error) {
            console.error(error);

            endButton.disabled =
                false;

            endButton.textContent =
                "End Session";

            showError(
                error.message ||
                    "Unable to end session."
            );
        }
    }
);

cancelEndButton.addEventListener(
    "click",
    async () => {
        clearError();

        cancelEndButton.disabled =
            true;

        confirmEndButton.disabled =
            true;

        cancelEndButton.textContent =
            "Keeping Session...";

        try {
            await window.relayn.cancelEndSession();

            hideEndRequest();

            setStatus(
                "Cancelling end request..."
            );
        } catch (error) {
            console.error(error);

            cancelEndButton.disabled =
                false;

            confirmEndButton.disabled =
                false;

            cancelEndButton.textContent =
                "Keep Session";

            showError(
                error.message ||
                    "Unable to keep the session active."
            );
        }
    }
);

confirmEndButton.addEventListener(
    "click",
    async () => {
        clearError();

        cancelEndButton.disabled =
            true;

        confirmEndButton.disabled =
            true;

        confirmEndButton.textContent =
            "Ending...";

        try {
            await window.relayn.confirmEndSession();

            setStatus(
                "Confirming session end..."
            );
        } catch (error) {
            console.error(error);

            cancelEndButton.disabled =
                false;

            confirmEndButton.disabled =
                false;

            confirmEndButton.textContent =
                "End Session";

            showError(
                error.message ||
                    "Unable to confirm session end."
            );
        }
    }
);

window.relayn.onSessionEvent(
    async (message) => {
        console.log(
            "Relayn event:",
            message
        );

        switch (message.type) {
            case "connected":
                setStatus(
                    "Connected to Relayn Server."
                );
                break;

            case "session.state": {
                const status =
                    message.payload?.status;

                const endRequestedBy =
                    message.payload?.endRequestedBy;

                if (
                    status === "CONNECTED"
                ) {
                    hideEndRequest();

                    setStatus(
                        "Customer connected.",
                        true
                    );

                    endButton.disabled =
                        false;

                    endButton.textContent =
                        "End Session";

                    requestAccessButton.disabled =
                        true;

                    if (!peerConnection) {
                        try {
                            await createPeerConnection();
                        } catch (error) {
                            console.error(
                                "Failed to create WebRTC connection:",
                                error
                            );

                            showError(
                                error.message ||
                                    "Unable to establish WebRTC connection."
                            );
                        }
                    }
                } else if (
                    status ===
                    "TECHNICIAN_REQUESTED"
                ) {
                    setStatus(
                        "Access request sent. Waiting for customer approval..."
                    );

                    requestAccessButton.disabled =
                        true;
                } else if (
                    status ===
                    "END_REQUESTED"
                ) {
                    if (
                        endRequestedBy ===
                        "customer"
                    ) {
                        showEndRequest();

                        setStatus(
                            "Customer wants to end the session."
                        );

                        endButton.disabled =
                            true;
                    } else if (
                        endRequestedBy ===
                        "technician"
                    ) {
                        hideEndRequest();

                        endButton.disabled =
                            true;

                        endButton.textContent =
                            "End Request Pending";

                        setStatus(
                            "Your end-session request was sent. Waiting for customer confirmation..."
                        );
                    }
                } else if (
                    status === "ENDED"
                ) {
                    hideEndRequest();

                    closePeerConnection();

                    setStatus(
                        "Session ended."
                    );

                    endButton.disabled =
                        true;

                    requestAccessButton.disabled =
                        true;

                    cancelEndButton.disabled =
                        true;

                    confirmEndButton.disabled =
                        true;
                } else if (
                    status === "EXPIRED"
                ) {
                    hideEndRequest();

                    closePeerConnection();

                    setStatus(
                        "Session expired."
                    );

                    endButton.disabled =
                        true;

                    requestAccessButton.disabled =
                        true;

                    cancelEndButton.disabled =
                        true;

                    confirmEndButton.disabled =
                        true;
                } else {
                    setStatus(
                        `Session status: ${status}`
                    );
                }

                break;
            }

            case "session.approved":
                setStatus(
                    "Customer approved the session.",
                    true
                );

                requestAccessButton.disabled =
                    true;

                endButton.disabled =
                    false;

                endButton.textContent =
                    "End Session";

                if (!peerConnection) {
                    try {
                        await createPeerConnection();
                    } catch (error) {
                        console.error(
                            "Failed to create WebRTC connection:",
                            error
                        );

                        showError(
                            error.message ||
                                "Unable to establish WebRTC connection."
                        );
                    }
                }

                break;

            case "session.rejected":
                closePeerConnection();

                setStatus(
                    "Customer rejected the access request."
                );

                requestAccessButton.disabled =
                    false;

                requestAccessButton.textContent =
                    "Request Access";

                break;

            case "signal":
                if (
                    message.payload?.fromRole ===
                    "customer"
                ) {
                    try {
                        await handleSignal(
                            message.payload?.data
                        );
                    } catch (error) {
                        console.error(
                            "Failed to handle WebRTC signal:",
                            error
                        );

                        showError(
                            error.message ||
                                "Unable to process WebRTC signaling data."
                        );
                    }
                }

                break;

            case "session.end.requested": {
                const requestedBy =
                    message.payload?.requestedBy;

                if (
                    requestedBy ===
                    "customer"
                ) {
                    showEndRequest();

                    setStatus(
                        "Customer wants to end the session."
                    );

                    endButton.disabled =
                        true;
                }

                break;
            }

            case "session.end.pending": {
                const requestedBy =
                    message.payload?.requestedBy;

                hideEndRequest();

                if (
                    requestedBy ===
                    "technician"
                ) {
                    endButton.disabled =
                        true;

                    endButton.textContent =
                        "End Request Pending";

                    setStatus(
                        "Your end-session request was sent. Waiting for customer confirmation..."
                    );
                }

                break;
            }

            case "session.end.cancelled": {
                const cancelledBy =
                    message.payload?.cancelledBy;

                hideEndRequest();

                cancelEndButton.disabled =
                    false;

                cancelEndButton.textContent =
                    "Keep Session";

                confirmEndButton.disabled =
                    false;

                confirmEndButton.textContent =
                    "End Session";

                endButton.disabled =
                    false;

                endButton.textContent =
                    "End Session";

                if (
                    cancelledBy ===
                    "customer"
                ) {
                    setStatus(
                        "Customer kept the session active.",
                        true
                    );
                } else {
                    setStatus(
                        "Session remains active.",
                        true
                    );
                }

                break;
            }

            case "session.ended":
                hideEndRequest();

                closePeerConnection();

                setStatus(
                    "Session ended."
                );

                endButton.disabled =
                    true;

                requestAccessButton.disabled =
                    true;

                cancelEndButton.disabled =
                    true;

                confirmEndButton.disabled =
                    true;

                break;

            case "error":
                showError(
                    message.payload?.message ||
                        "Relayn server error."
                );

                break;

            case "disconnected":
                closePeerConnection();

                setStatus(
                    "Disconnected from Relayn Server."
                );

                break;

            default:
                break;
        }
    }
);
