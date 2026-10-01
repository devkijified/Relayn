// =========================================================================
// RELAYN — Device A (extract-from) renderer
// -------------------------------------------------------------------------
// Speaks the server protocol via window.relayn (see device-a/preload.js).
// Server -> renderer event types:
//   connected | session.state | session.requested | session.approved |
//   session.rejected | session.ended | signal (payload {fromRole, data}) |
//   session.end.requested | session.end.pending | session.end.cancelled |
//   ice.config | error | disconnected
// Device A is the WebRTC answerer. On data-channel open it extracts the
// named auth cookie and sends {type:"session.migrate", cookie}; Device B
// replies {type:"session.migrated"} or {type:"session.migrate.failed"}.
// =========================================================================

const startView = document.getElementById("startView");
const sessionView = document.getElementById("sessionView");
const startButton = document.getElementById("startButton");
const sessionCode = document.getElementById("sessionCode");
const sessionStatus = document.getElementById("sessionStatus");

const requestSection = document.getElementById("requestSection");
const rejectButton = document.getElementById("rejectButton");
const approveButton = document.getElementById("approveButton");

const endRequestSection = document.getElementById("endRequestSection");
const cancelEndButton = document.getElementById("cancelEndButton");
const confirmEndButton = document.getElementById("confirmEndButton");
const endButton = document.getElementById("endButton");

const errorBox = document.getElementById("error");

let currentSession = null; // { sessionId, code, expiresAt }
let peerConnection = null;
let dataChannel = null;

// Base STUN list. TURN servers minted by the signaling server arrive via
// the "ice.config" event and are appended for subsequent peer connections.
const BASE_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
];
let dynamicIceServers = [];

/*
 * ICE candidates can arrive before the remote description has been installed.
 * Keep them here until setRemoteDescription() has completed.
 */
let pendingIceCandidates = [];
let remoteDescriptionSet = false;

// The cookie this app extracts and migrates on connect.
const MIGRATED_COOKIE_NAME = "session_id";

function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add("visible");
}

function clearError() {
    errorBox.textContent = "";
    errorBox.classList.remove("visible");
}

function setStatus(message, connected = false) {
    sessionStatus.textContent = message;
    sessionStatus.classList.toggle("connected", connected);
}

function showEndRequest(requestedBy) {
    if (requestedBy !== "technician") {
        return;
    }

    endRequestSection.classList.add("visible");
    cancelEndButton.disabled = false;
    cancelEndButton.textContent = "Keep Session";
    confirmEndButton.disabled = false;
    confirmEndButton.textContent = "End Session";
}

function hideEndRequest() {
    endRequestSection.classList.remove("visible");
}

function showSession(session) {
    currentSession = session;
    startView.style.display = "none";
    sessionView.classList.add("visible");
    sessionCode.textContent = session.code;
    setStatus(`Session status: ${session.status || "ACTIVE"}`);
}

function disableSessionControls() {
    endButton.disabled = true;
    approveButton.disabled = true;
    rejectButton.disabled = true;
    cancelEndButton.disabled = true;
    confirmEndButton.disabled = true;
}

// Return to a clean start screen so a new session can be created without
// restarting the app. Called when the session ends.
function resetToStartView() {
    currentSession = null;
    clearError();
    hideEndRequest();
    requestSection.classList.remove("visible");
    closePeerConnection();
    sessionView.classList.remove("visible");
    startView.style.display = "";
    sessionCode.textContent = "------";
    setStatus("Connecting to Relayn...");
    startButton.disabled = false;
    startButton.textContent = "Start Support Session";
    endButton.disabled = false;
    endButton.textContent = "End Session";
    approveButton.disabled = false;
    rejectButton.disabled = false;
    cancelEndButton.disabled = false;
    cancelEndButton.textContent = "Keep Session";
    confirmEndButton.disabled = false;
    confirmEndButton.textContent = "End Session";
}

function tearDownPeerConnection() {
    remoteDescriptionSet = false;

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

function closePeerConnection() {
    tearDownPeerConnection();
    pendingIceCandidates = [];
}

async function flushPendingIceCandidates() {
    const pc = peerConnection;

    if (!pc || !remoteDescriptionSet || pendingIceCandidates.length === 0) {
        return;
    }

    const candidates = pendingIceCandidates;
    pendingIceCandidates = [];

    for (const candidate of candidates) {
        if (peerConnection !== pc) {
            break;
        }

        try {
            await pc.addIceCandidate(candidate);
        } catch (error) {
            console.error("Failed to add queued WebRTC ICE candidate:", error);
        }
    }
}

function sendControlMessage(message) {
    if (!dataChannel || dataChannel.readyState !== "open") {
        console.warn("WebRTC data channel is not open.");
        return false;
    }

    dataChannel.send(JSON.stringify(message));
    return true;
}

// Extract the auth cookie and send it to Device B. The status is only
// marked successful when Device B acknowledges the injection.
async function migrateSessionCookie() {
    setStatus("Transferring access to technician...", true);

    try {
        const result = await window.relayn.extractAuthCookie(MIGRATED_COOKIE_NAME);

        if (!result?.success) {
            throw new Error(result?.error || "Unable to read the local session cookie.");
        }

        const sent = sendControlMessage({
            type: "session.migrate",
            cookie: result.payload
        });

        if (!sent) {
            throw new Error("Data channel closed before the cookie could be sent.");
        }

        setStatus("Access sent. Waiting for confirmation...", true);
    } catch (error) {
        console.error("Failed to extract or send session cookie:", error);
        showError(error.message || "Unable to transfer access to the technician.");

        sendControlMessage({
            type: "session.migrate.failed",
            error: error.message || "Unable to extract the session cookie."
        });
    }
}

function handleMigrationAck(message) {
    if (message.type === "session.migrated") {
        setStatus("Access active on technician device.", true);
        return;
    }

    if (message.type === "session.migrate.failed") {
        showError(`Technician could not activate access: ${message.error || "unknown error"}`);
        setStatus("Access transfer failed.", false);
    }
}

async function handleOffer(offer) {
    tearDownPeerConnection();

    peerConnection = new RTCPeerConnection({
        iceTransportPolicy: "all",
        iceServers: [...BASE_ICE_SERVERS, ...dynamicIceServers]
    });

    peerConnection.onicecandidateerror = (e) => {
        console.warn("ICE candidate error:", e.errorCode, e.errorText);
    };

    peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;

        dataChannel.onopen = () => {
            migrateSessionCookie();
        };

        dataChannel.onclose = () => {
            console.log("Relayn WebRTC data channel closed.");
        };

        dataChannel.onerror = (error) => {
            console.error("Relayn WebRTC data channel error:", error);
        };

        dataChannel.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (error) {
                console.error("Invalid WebRTC control message:", error);
                return;
            }

            // Never log full data-channel payloads; only the message type.
            if (message.type === "session.migrated" || message.type === "session.migrate.failed") {
                handleMigrationAck(message);
            }
        };
    };

    peerConnection.onicecandidate = async (event) => {
        if (!event.candidate || !peerConnection) {
            return;
        }

        try {
            await window.relayn.sendSignal("technician", {
                type: "ice-candidate",
                candidate: event.candidate.toJSON()
            });
        } catch (error) {
            console.error("Failed to send ICE candidate:", error);
        }
    };

    peerConnection.onconnectionstatechange = () => {
        if (!peerConnection) return;

        switch (peerConnection.connectionState) {
            case "new":
            case "connecting":
                setStatus("WebRTC connecting...");
                break;
            case "connected":
                setStatus("WebRTC connected.", true);
                break;
            case "disconnected":
                setStatus("WebRTC disconnected.");
                break;
            case "failed":
                setStatus("WebRTC connection failed.");
                break;
            case "closed":
                setStatus("WebRTC connection closed.");
                break;
        }
    };

    await peerConnection.setRemoteDescription(offer);
    remoteDescriptionSet = true;

    await flushPendingIceCandidates();

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    await window.relayn.sendSignal("technician", {
        type: "answer",
        answer
    });
}

async function handleSignal(data) {
    if (!data) return;

    if (data.type === "offer") {
        await handleOffer(data.offer);
        return;
    }

    if (data.type === "ice-candidate") {
        if (!data.candidate) return;

        if (!peerConnection || !remoteDescriptionSet) {
            pendingIceCandidates.push(data.candidate);
            return;
        }

        try {
            await peerConnection.addIceCandidate(data.candidate);
        } catch (error) {
            console.error("Failed to add WebRTC ICE candidate:", error);
        }
    }
}

// -------------------------------------------------------------------------
// UI event listeners
// -------------------------------------------------------------------------

startButton.addEventListener("click", async () => {
    clearError();
    startButton.disabled = true;
    startButton.textContent = "Creating Session...";

    try {
        const session = await window.relayn.createSession();
        showSession(session);
        setStatus("Waiting for technician to connect...");
    } catch (error) {
        console.error(error);
        showError(error.message || "Unable to create support session.");
        startButton.disabled = false;
        startButton.textContent = "Start Support Session";
    }
});

approveButton.addEventListener("click", async () => {
    clearError();
    approveButton.disabled = true;
    rejectButton.disabled = true;
    approveButton.textContent = "Approving...";

    try {
        await window.relayn.approveSession();
        setStatus("Approving technician...");
    } catch (error) {
        console.error(error);
        showError(error.message || "Unable to approve session.");
        approveButton.disabled = false;
        rejectButton.disabled = false;
        approveButton.textContent = "Approve";
    }
});

rejectButton.addEventListener("click", async () => {
    clearError();
    approveButton.disabled = true;
    rejectButton.disabled = true;
    rejectButton.textContent = "Rejecting...";

    try {
        await window.relayn.rejectSession();
        setStatus("Access request rejected.");
        requestSection.classList.remove("visible");
        approveButton.disabled = false;
        rejectButton.disabled = false;
        approveButton.textContent = "Approve";
        rejectButton.textContent = "Reject";
    } catch (error) {
        console.error(error);
        showError(error.message || "Unable to reject session.");
        approveButton.disabled = false;
        rejectButton.disabled = false;
        rejectButton.textContent = "Reject";
    }
});

endButton.addEventListener("click", async () => {
    clearError();
    endButton.disabled = true;
    endButton.textContent = "Requesting...";

    try {
        await window.relayn.endSession();
        hideEndRequest();
        setStatus("Your end-session request was sent. Waiting for technician confirmation...");
    } catch (error) {
        console.error(error);
        endButton.disabled = false;
        endButton.textContent = "End Session";
        showError(error.message || "Unable to end session.");
    }
});

cancelEndButton.addEventListener("click", async () => {
    clearError();
    cancelEndButton.disabled = true;
    confirmEndButton.disabled = true;
    cancelEndButton.textContent = "Keeping Session...";

    try {
        await window.relayn.cancelEndSession();
        hideEndRequest();
        setStatus("Cancelling end request...");
    } catch (error) {
        console.error(error);
        cancelEndButton.disabled = false;
        confirmEndButton.disabled = false;
        cancelEndButton.textContent = "Keep Session";
        showError(error.message || "Unable to keep the session active.");
    }
});

confirmEndButton.addEventListener("click", async () => {
    clearError();
    cancelEndButton.disabled = true;
    confirmEndButton.disabled = true;
    confirmEndButton.textContent = "Ending...";

    try {
        await window.relayn.confirmEndSession();
        setStatus("Confirming session end...");
    } catch (error) {
        console.error(error);
        cancelEndButton.disabled = false;
        confirmEndButton.disabled = false;
        confirmEndButton.textContent = "End Session";
        showError(error.message || "Unable to confirm session end.");
    }
});

// -------------------------------------------------------------------------
// Server event dispatcher
// -------------------------------------------------------------------------

window.relayn.onSessionEvent(async (message) => {
    const payload = message.payload || {};

    switch (message.type) {
        case "connected":
            setStatus("Connected to Relayn Server.");
            break;

        case "session.state":
            if (payload.status === "ENDED" || payload.status === "EXPIRED") {
                closePeerConnection();
                setStatus(`Session ${payload.status.toLowerCase()}.`);
                disableSessionControls();
            }
            break;

        case "session.requested":
            requestSection.classList.add("visible");
            approveButton.disabled = false;
            rejectButton.disabled = false;
            approveButton.textContent = "Approve";
            rejectButton.textContent = "Reject";
            setStatus("Technician is requesting access.");
            break;

        case "session.approved":
            requestSection.classList.remove("visible");
            setStatus("Technician connected.", true);
            endButton.disabled = false;
            endButton.textContent = "End Session";
            break;

        case "session.rejected":
            requestSection.classList.remove("visible");
            closePeerConnection();
            setStatus("Access request rejected.");
            approveButton.disabled = false;
            rejectButton.disabled = false;
            approveButton.textContent = "Approve";
            rejectButton.textContent = "Reject";
            break;

        case "signal":
            if (payload.fromRole === "technician") {
                try {
                    await handleSignal(payload.data);
                } catch (error) {
                    console.error("Failed to handle WebRTC signal:", error);
                    showError(error.message || "Unable to process WebRTC signaling data.");
                }
            }
            break;

        case "session.end.requested":
            if (payload.requestedBy === "technician") {
                showEndRequest(payload.requestedBy);
                setStatus("Technician wants to end the session.");
            }
            break;

        case "session.end.pending":
            hideEndRequest();
            if (payload.requestedBy === "customer") {
                endButton.disabled = true;
                endButton.textContent = "End Request Pending";
                setStatus("Your end-session request was sent. Waiting for technician confirmation...");
            }
            break;

        case "session.end.cancelled":
            hideEndRequest();
            cancelEndButton.disabled = false;
            cancelEndButton.textContent = "Keep Session";
            confirmEndButton.disabled = false;
            confirmEndButton.textContent = "End Session";
            endButton.disabled = false;
            endButton.textContent = "End Session";
            setStatus(
                payload.cancelledBy === "technician"
                    ? "Technician kept the session active."
                    : "Session remains active.",
                true
            );
            break;

        case "session.ended":
            // Back to the start screen so a new session can be created.
            resetToStartView();
            break;

        case "ice.config":
            // Future TURN hook: server-minted ICE servers for the next
            // peer connection. Never logged beyond the event type.
            if (Array.isArray(payload.iceServers)) {
                dynamicIceServers = payload.iceServers;
            }
            break;

        case "error":
            showError(payload.message || "Relayn server error.");
            break;

        case "disconnected":
            closePeerConnection();
            setStatus("Disconnected from Relayn Server.");
            break;

        default:
            break;
    }
});
