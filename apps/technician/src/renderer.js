// =========================================================================
// RELAYN — Device B (inject-to) renderer
// -------------------------------------------------------------------------
// Speaks the server protocol via window.relayn (see device-b/preload.js).
// Server -> renderer event types:
//   connected | session.state | session.approved | session.rejected |
//   session.ended | signal (payload {fromRole, data}) |
//   session.end.requested | session.end.pending | session.end.cancelled |
//   ice.config | error | disconnected
// Device B is the WebRTC offerer. On receiving {type:"session.migrate"}
// over the data channel it injects the cookie, then replies
// {type:"session.migrated"} or {type:"session.migrate.failed"} so Device A
// never reports success it did not get.
// =========================================================================

const joinView = document.getElementById("joinView");
const sessionView = document.getElementById("sessionView");
const codeInput = document.getElementById("codeInput");
const joinButton = document.getElementById("joinButton");
const sessionCodeEl = document.getElementById("sessionCode");
const sessionStatus = document.getElementById("sessionStatus");

const requestSection = document.getElementById("requestSection");
const requestAccessButton = document.getElementById("requestAccessButton");

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

let pendingIceCandidates = [];
let remoteDescriptionSet = false;

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
    if (requestedBy !== "customer") {
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

// Return to a clean join screen so a new session can start without
// restarting the app. Called when the session ends.
function resetToJoinView() {
    currentSession = null;
    clearError();
    hideEndRequest();
    requestSection.classList.remove("visible");
    closePeerConnection();
    sessionView.classList.remove("visible");
    joinView.style.display = "";
    codeInput.value = "";
    sessionCodeEl.textContent = "------";
    setStatus("Connecting to Relayn...");
    joinButton.disabled = false;
    joinButton.textContent = "Join Session";
    requestAccessButton.disabled = false;
    requestAccessButton.textContent = "Request Access";
    endButton.disabled = false;
    endButton.textContent = "End Session";
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
        if (peerConnection !== pc) break;

        try {
            await pc.addIceCandidate(candidate);
        } catch (error) {
            console.error("Failed to add queued WebRTC ICE candidate:", error);
        }
    }
}

// -------------------------------------------------------------------------
// Join + request access
// -------------------------------------------------------------------------

joinButton.addEventListener("click", async () => {
    clearError();
    const code = codeInput.value.trim();

    if (!code) {
        showError("Please enter the support code.");
        return;
    }

    joinButton.disabled = true;
    joinButton.textContent = "Joining Session...";

    try {
        const session = await window.relayn.joinSession(code);
        currentSession = session;

        joinView.style.display = "none";
        sessionView.classList.add("visible");
        sessionCodeEl.textContent = session.code;
        setStatus("Joined session. Ready to request access.");
    } catch (error) {
        console.error(error);
        showError(error.message || "Unable to join session.");
        joinButton.disabled = false;
        joinButton.textContent = "Join Session";
    }
});

requestAccessButton.addEventListener("click", async () => {
    clearError();
    requestAccessButton.disabled = true;
    requestAccessButton.textContent = "Requesting Access...";

    try {
        await window.relayn.requestAccess();
        setStatus("Access request sent. Waiting for approval...");
    } catch (error) {
        console.error(error);
        showError(error.message || "Unable to request access.");
        requestAccessButton.disabled = false;
        requestAccessButton.textContent = "Request Access";
    }
});

// -------------------------------------------------------------------------
// WebRTC (Device B is the offerer)
// -------------------------------------------------------------------------

async function initializeWebRTC() {
    tearDownPeerConnection();

    peerConnection = new RTCPeerConnection({
        iceTransportPolicy: "all",
        iceServers: [...BASE_ICE_SERVERS, ...dynamicIceServers]
    });

    // Device B creates the data channel as the offerer.
    dataChannel = peerConnection.createDataChannel("relayn-channel");
    setupDataChannelHandlers();

    peerConnection.onicecandidate = async (event) => {
        if (!event.candidate || !peerConnection) return;

        try {
            await window.relayn.sendSignal("customer", {
                type: "ice-candidate",
                candidate: event.candidate.toJSON()
            });
        } catch (error) {
            console.error("Failed to send ICE candidate:", error);
        }
    };

    peerConnection.onicecandidateerror = (e) => {
        console.warn("ICE candidate error:", e.errorCode, e.errorText);
    };

    peerConnection.onconnectionstatechange = () => {
        if (!peerConnection) return;

        switch (peerConnection.connectionState) {
            case "new":
            case "connecting":
                setStatus("WebRTC connecting...");
                break;
            case "connected":
                setStatus("WebRTC connected securely.", true);
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

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    await window.relayn.sendSignal("customer", {
        type: "offer",
        offer
    });
}

function setupDataChannelHandlers() {
    dataChannel.onopen = () => {
        setStatus("Secure data channel open. Waiting for session migration...", true);
    };

    dataChannel.onclose = () => {
        setStatus("Data channel closed.");
    };

    dataChannel.onerror = (error) => {
        console.error("Relayn WebRTC data channel error:", error);
    };

    dataChannel.onmessage = async (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (error) {
            console.error("Invalid WebRTC control message:", error);
            return;
        }

        // Only the message type is logged — never the payload.
        if (message.type === "session.migrate") {
            await handleSessionMigrate(message.cookie);
        }
    };
}

// Inject the migrated cookie, then acknowledge the result so Device A
// reports the true outcome.
async function handleSessionMigrate(cookie) {
    setStatus("Received session data. Injecting into secure storage...", true);

    try {
        const result = await window.relayn.injectAuthCookie(cookie);

        if (!result?.success) {
            throw new Error(result?.error || "Failed to inject auth cookie.");
        }

        setStatus("Session successfully migrated! Access granted.", true);

        if (dataChannel && dataChannel.readyState === "open") {
            dataChannel.send(JSON.stringify({ type: "session.migrated" }));
        }
    } catch (error) {
        console.error("Cookie injection failed:", error.message);
        showError(`Migration failed: ${error.message}`);

        if (dataChannel && dataChannel.readyState === "open") {
            dataChannel.send(JSON.stringify({
                type: "session.migrate.failed",
                error: error.message
            }));
        }
    }
}

async function handleSignal(data) {
    if (!data) return;

    if (data.type === "answer") {
        // Guard: an answer with no live peer connection (e.g. after a
        // teardown) must not throw.
        if (!peerConnection) {
            console.warn("Received WebRTC answer with no peer connection; ignoring.");
            return;
        }

        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        remoteDescriptionSet = true;
        await flushPendingIceCandidates();
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
// Session termination
// -------------------------------------------------------------------------

endButton.addEventListener("click", async () => {
    clearError();
    endButton.disabled = true;
    endButton.textContent = "Requesting...";

    try {
        await window.relayn.endSession();
        hideEndRequest();
        setStatus("End session request sent. Waiting for confirmation...");
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
        showError(error.message || "Unable to keep session active.");
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
                endButton.disabled = true;
            }
            break;

        case "session.approved":
            requestSection.classList.remove("visible");
            setStatus("Access approved! Initializing WebRTC...", true);
            try {
                await initializeWebRTC();
            } catch (error) {
                console.error("WebRTC initialization failed:", error);
                showError(error.message || "Unable to initialize WebRTC.");
            }
            break;

        case "session.rejected":
            setStatus("Access request rejected.");
            requestSection.classList.add("visible");
            requestAccessButton.disabled = false;
            requestAccessButton.textContent = "Request Access";
            closePeerConnection();
            break;

        case "signal":
            if (payload.fromRole === "customer") {
                try {
                    await handleSignal(payload.data);
                } catch (error) {
                    console.error("Failed to handle WebRTC signal:", error);
                    showError(error.message || "Unable to process WebRTC signal.");
                }
            }
            break;

        case "session.end.requested":
            if (payload.requestedBy === "customer") {
                showEndRequest(payload.requestedBy);
                setStatus("Other device wants to end the session.");
            }
            break;

        case "session.end.pending":
            hideEndRequest();
            if (payload.requestedBy === "technician") {
                endButton.disabled = true;
                endButton.textContent = "End Request Pending";
                setStatus("End request sent. Waiting for confirmation...");
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
            setStatus("Session remains active.", true);
            break;

        case "session.ended":
            // Main process removes the injected cookie on this event.
            // Back to the join screen so a new session can start.
            resetToJoinView();
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
