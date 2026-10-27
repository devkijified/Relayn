// =========================================================================
// RELAYN — popup UI (thin client).
// All state lives in background.js; this file sends actions and renders
// the uiState snapshot it receives. Reopening the popup re-syncs.
// Branding (name, tagline, bio, colour, server URL, feature flags) comes
// from config.json — see applyBrand() below.
// =========================================================================

const $ = (id) => document.getElementById(id);

const els = {
    // Brand
    brandName: $("brandName"),
    brandTagline: $("brandTagline"),
    brandBio: $("brandBio"),
    brandNameServer: $("brandNameServer"),
    shareSection: $("shareSection"),
    scanSection: $("scanSection"),
    // Status
    statusBox: $("statusBox"),
    errorBox: $("errorBox"),
    shareButton: $("shareButton"),
    // QR share (Device A)
    shareQrCard: $("shareQrCard"),
    qrCodeBox: $("qrCodeBox"),
    qrExpiryHint: $("qrExpiryHint"),
    downloadQrButton: $("downloadQrButton"),
    closeQrButton: $("closeQrButton"),
    // Share diagnostics (Device A)
    diagnoseButton: $("diagnoseButton"),
    diagnoseResultBox: $("diagnoseResultBox"),
    // Restore diagnostics (Device B)
    restoreStatusButton: $("restoreStatusButton"),
    restoreStatusBox: $("restoreStatusBox"),
    restoreLogCard: $("restoreLogCard"),
    restoreLogTitle: $("restoreLogTitle"),
    restoreLogBox: $("restoreLogBox"),
    // QR scan (Device B)
    scanQrButton: $("scanQrButton"),
    scanQrCard: $("scanQrCard"),
    startCameraButton: $("startCameraButton"),
    uploadQrButton: $("uploadQrButton"),
    qrFileInput: $("qrFileInput"),
    qrVideo: $("qrVideo"),
    qrCanvas: $("qrCanvas"),
    scanHint: $("scanHint"),
    stopScanButton: $("stopScanButton"),
    // Admin inbox (account shares)
    inboxSection: $("inboxSection"),
    inboxList: $("inboxList"),
    refreshInboxButton: $("refreshInboxButton"),
    inboxError: $("inboxError"),
    // Server URL (hidden unless features.serverCard in config.json)
    serverCard: $("serverCard"),
    serverUrlInput: $("serverUrlInput"),
    saveServerButton: $("saveServerButton"),
    resetServerButton: $("resetServerButton"),
    serverSavedBox: $("serverSavedBox"),
    serverErrorBox: $("serverErrorBox"),
};

// ------------------------------------------------------------------------
// Whitelabel brand config.
// ------------------------------------------------------------------------
const DEFAULT_BRAND = {
    brand: {
        name: "Relayn",
        tagline: "Move your logins to another device",
        bio: "Move your logins to another device: share this browser via an encrypted QR code, scan it on the other device, done.",
        primaryColor: "#1a73e8",
        successBackground: "#e6f4ea",
        successColor: "#137333",
        shareButtonText: "📤 Share this device",
        scanButtonText: "📷 Scan QR code",
    },
    server: { url: "https://relayn-server.onrender.com" },
    features: { share: true, scan: true, serverCard: false, inbox: false, localStorage: true, history: true, indexedDB: true },
};

const BRAND = JSON.parse(JSON.stringify(DEFAULT_BRAND));

function mergeBrandConfig(raw) {
    if (!raw || typeof raw !== "object") return;
    const b = raw.brand;
    if (b && typeof b === "object") {
        if (typeof b.name === "string" && b.name.trim()) BRAND.brand.name = b.name.trim().slice(0, 60);
        if (typeof b.tagline === "string" && b.tagline.trim()) BRAND.brand.tagline = b.tagline.trim().slice(0, 120);
        if (typeof b.bio === "string" && b.bio.trim()) BRAND.brand.bio = b.bio.trim().slice(0, 300);
        if (typeof b.primaryColor === "string" && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(b.primaryColor.trim())) {
            BRAND.brand.primaryColor = b.primaryColor.trim();
        }
        if (typeof b.successBackground === "string" && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(b.successBackground.trim())) {
            BRAND.brand.successBackground = b.successBackground.trim();
        }
        if (typeof b.successColor === "string" && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(b.successColor.trim())) {
            BRAND.brand.successColor = b.successColor.trim();
        }
        if (typeof b.shareButtonText === "string" && b.shareButtonText.trim()) {
            BRAND.brand.shareButtonText = b.shareButtonText.trim().slice(0, 80);
        }
        if (typeof b.scanButtonText === "string" && b.scanButtonText.trim()) {
            BRAND.brand.scanButtonText = b.scanButtonText.trim().slice(0, 80);
        }
    }
    const f = raw.features;
    if (f && typeof f === "object") {
        for (const key of ["share", "scan", "serverCard", "inbox", "localStorage", "history", "indexedDB"]) {
            if (typeof f[key] === "boolean") BRAND.features[key] = f[key];
        }
    }
}

function applyBrand() {
    document.title = BRAND.brand.name;
    els.brandName.textContent = BRAND.brand.name;
    els.brandTagline.textContent = BRAND.brand.tagline;
    els.brandBio.textContent = BRAND.brand.bio;
    els.brandNameServer.textContent = BRAND.brand.name;
    els.scanQrButton.textContent = BRAND.brand.scanButtonText;
    document.documentElement.style.setProperty("--primary", BRAND.brand.primaryColor);
    document.documentElement.style.setProperty("--success-bg", BRAND.brand.successBackground);
    document.documentElement.style.setProperty("--success-color", BRAND.brand.successColor);
    els.shareSection.classList.toggle("hidden", !BRAND.features.share);
    els.scanSection.classList.toggle("hidden", !BRAND.features.scan);
    els.serverCard.classList.toggle("hidden", !BRAND.features.serverCard);
    els.inboxSection.classList.toggle("hidden", !BRAND.features.inbox);
}

async function initBrand() {
    try {
        const res = await fetch(chrome.runtime.getURL("config.json"));
        if (res && res.ok) mergeBrandConfig(await res.json());
    } catch {
        // Defaults stand.
    }
    applyBrand();
}

// ------------------------------------------------------------------------
// Popup <-> worker channel.
// ------------------------------------------------------------------------
let lastUiState = null;
let port = null;

function refreshState() {
    sendAction("getState").then((res) => {
        if (res && res.ok) render(res.state);
    });
}
function connectPort() {
    port = chrome.runtime.connect({ name: "relayn-popup" });
    port.onMessage.addListener((message) => {
        if (message && message.kind === "ui" && message.op === "sync") {
            render(message.state);
        }
    });
    port.onDisconnect.addListener(() => {
        setTimeout(() => {
            connectPort();
            refreshState();
        }, 500);
    });
}
connectPort();

function sendAction(action, data) {
    return chrome.runtime.sendMessage({ kind: "action", action, data });
}

function render(state) {
    lastUiState = state;

    els.statusBox.textContent = state.status || "Ready.";
    els.statusBox.classList.toggle("connected", !!state.statusConnected);

    if (state.error) {
        els.errorBox.textContent = state.error;
        els.errorBox.classList.remove("hidden");
    } else {
        els.errorBox.classList.add("hidden");
    }

    const busy = !!state.busy;
    els.shareButton.disabled = busy;
    els.shareButton.textContent = busy ? state.busyLabel || "Working…" : BRAND.brand.shareButtonText;
    els.scanQrButton.disabled = busy;
    els.startCameraButton.disabled = busy;
    els.uploadQrButton.disabled = busy;

    renderShareQr(state);
    renderReceivedBackup(state);
    renderRestoreLog(state);
}

// Restore-activity log (Device B): lines pushed by the content script via
// the worker, newest last. Hidden when empty.
function renderRestoreLog(state) {
    if (!els.restoreLogCard) return;
    const log = (state && state.restoreLog) || [];
    els.restoreLogCard.classList.toggle("hidden", log.length === 0);
    if (log.length) els.restoreLogBox.textContent = log.join("\n");
}

function showError(message) {
    els.errorBox.textContent = message;
    els.errorBox.classList.remove("hidden");
}

// ------------------------------------------------------------------------
// QR share (Device A) — render the code + live expiry countdown.
// ------------------------------------------------------------------------
let lastQrPayload = null;
let qrExpiryTimer = 0;

function renderShareQr(state) {
    const qr = state.shareQr;
    els.shareQrCard.classList.toggle("hidden", !qr);
    if (!qr) {
        lastQrPayload = null;
        if (qrExpiryTimer) { clearInterval(qrExpiryTimer); qrExpiryTimer = 0; }
        return;
    }
    if (qr.payload !== lastQrPayload) {
        lastQrPayload = qr.payload;
        els.qrCodeBox.innerHTML = "";
        try {
            // Vendored qrcodejs (global QRCode).
            new QRCode(els.qrCodeBox, {
                text: qr.payload,
                width: 200,
                height: 200,
                correctLevel: QRCode.CorrectLevel.M,
            });
        } catch (error) {
            els.qrCodeBox.textContent = "Could not render QR code.";
        }
    }
    const updateExpiry = () => {
        const ms = Date.parse(qr.expiresAt) - Date.now();
        if (ms <= 0) {
            els.qrExpiryHint.textContent = "Expired — share again for a new code.";
            return;
        }
        const s = Math.ceil(ms / 1000);
        els.qrExpiryHint.textContent = `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    updateExpiry();
    if (qrExpiryTimer) clearInterval(qrExpiryTimer);
    qrExpiryTimer = setInterval(updateExpiry, 1000);
}

els.shareButton.addEventListener("click", async () => {
    const res = await sendAction("shareDevice");
    if (!res || res.ok === false) {
        showError((res && res.error) || "Could not share this device.");
    }
    // On success the worker's uiState sync renders the QR card.
});

els.closeQrButton.addEventListener("click", () => {
    sendAction("clearShareQr");
});

// Diagnostics (Device A): what would a share capture right now?
// Counts only — never secret values. Tells us whether WhatsApp's tab is
// open and whether its session lives in localStorage or IndexedDB.
if (els.diagnoseButton) {
    els.diagnoseButton.addEventListener("click", async () => {
        els.diagnoseButton.disabled = true;
        els.diagnoseButton.textContent = "Checking…";
        els.diagnoseResultBox.classList.add("hidden");
        try {
            const res = await sendAction("diagnoseStorage");
            els.diagnoseResultBox.textContent =
                res && res.ok ? res.summary : (res && res.error) || "Could not run diagnostics.";
            els.diagnoseResultBox.classList.remove("hidden");
        } finally {
            els.diagnoseButton.disabled = false;
            els.diagnoseButton.textContent = "🔍 Check what's captured";
        }
    });
}

// Restore diagnostics (Device B): what the content script actually
// restored on this device — per origin, keys + IndexedDB DBs + failures.
if (els.restoreStatusButton) {
    els.restoreStatusButton.addEventListener("click", async () => {
        els.restoreStatusButton.disabled = true;
        els.restoreStatusButton.textContent = "Checking…";
        els.restoreStatusBox.classList.add("hidden");
        try {
            const res = await sendAction("getRestoreStatus");
            els.restoreStatusBox.textContent =
                res && res.ok ? res.summary : (res && res.error) || "Could not run diagnostics.";
            els.restoreStatusBox.classList.remove("hidden");
        } finally {
            els.restoreStatusButton.disabled = false;
            els.restoreStatusButton.textContent = "🔍 Check restore status";
        }
    });
}

// Download the QR as a PNG so it can be sent to the other device
// (chat, email, …) when the camera can't be used for scanning.
els.downloadQrButton.addEventListener("click", () => {
    const canvas = els.qrCodeBox.querySelector("canvas");
    const img = els.qrCodeBox.querySelector("img");
    if (!canvas && !img) {
        showError("The QR code is not ready yet.");
        return;
    }
    const a = document.createElement("a");
    a.href = canvas ? canvas.toDataURL("image/png") : img.src;
    a.download = "relayn-share-qr.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
});

// ------------------------------------------------------------------------
// QR scan (Device B) — camera or uploaded image + jsQR, then fully
// automatic: download -> decrypt -> import everything -> "You're logged in."
// ------------------------------------------------------------------------
let scanStream = null;
let scanRaf = 0;
let scanning = false;

function stopScan(message) {
    scanning = false;
    if (scanRaf) { cancelAnimationFrame(scanRaf); scanRaf = 0; }
    if (scanStream) {
        for (const track of scanStream.getTracks()) track.stop();
        scanStream = null;
    }
    if (els.qrVideo) {
        try { els.qrVideo.pause(); } catch { /* noop */ }
        els.qrVideo.srcObject = null;
        els.qrVideo.classList.add("hidden");
    }
    els.scanQrCard.classList.add("hidden");
    if (message) els.scanHint.textContent = message;
}

async function handleScannedPayload(data) {
    const res = await sendAction("consumeShare", { payload: data });
    if (!res || res.ok === false) {
        showError((res && res.error) || "Could not use this share code.");
    }
    // On success the worker drives the UI from here: download, decrypt,
    // auto-import, done.
}

function decodeQrImage(data, width, height) {
    try {
        return jsQR(data, width, height);
    } catch {
        return null;
    }
}

function scanTick() {
    if (!scanning) return;
    const video = els.qrVideo;
    const canvas = els.qrCanvas;
    try {
        if (video.videoWidth > 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const result = decodeQrImage(imageData.data, canvas.width, canvas.height);
            if (result && result.data) {
                stopScan();
                handleScannedPayload(result.data);
                return;
            }
        }
    } catch { /* keep scanning */ }
    scanRaf = requestAnimationFrame(scanTick);
}

async function startCamera() {
    els.scanHint.textContent = "Starting camera…";
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("This device has no camera access.");
        }
        scanStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment" },
            audio: false,
        });
        els.qrVideo.classList.remove("hidden");
        els.qrVideo.srcObject = scanStream;
        await els.qrVideo.play();
        els.scanHint.textContent = "Point the camera at Device A's QR code…";
        scanning = true;
        scanTick();
    } catch (error) {
        if (scanStream) {
            for (const track of scanStream.getTracks()) track.stop();
            scanStream = null;
        }
        els.scanHint.textContent =
            error && error.name === "NotAllowedError"
                ? "Camera access was denied — allow it, or upload a QR image instead."
                : "Could not start the camera — upload a QR image instead.";
    }
}

// Decode a QR code from an uploaded image file (screenshot/photo).
async function handleQrFile(file) {
    if (!file) return;
    els.scanHint.textContent = "Reading QR image…";
    try {
        const bitmap = await createImageBitmap(file);
        try {
            const canvas = els.qrCanvas;
            // Downscale giant photos — QR decodes fine smaller, much faster.
            const maxDim = 1200;
            const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const result = decodeQrImage(imageData.data, canvas.width, canvas.height);
            if (result && result.data) {
                stopScan();
                handleScannedPayload(result.data);
            } else {
                els.scanHint.textContent = "No QR code found in that image — try a clearer screenshot.";
            }
        } finally {
            if (bitmap.close) bitmap.close();
        }
    } catch (error) {
        els.scanHint.textContent = "Could not read that image file.";
    }
}

els.scanQrButton.addEventListener("click", () => {
    stopScan();
    els.scanHint.textContent = "";
    els.scanQrCard.classList.remove("hidden");
});

els.startCameraButton.addEventListener("click", () => {
    startCamera();
});

els.uploadQrButton.addEventListener("click", () => {
    els.qrFileInput.click();
});

els.qrFileInput.addEventListener("change", () => {
    const file = els.qrFileInput.files && els.qrFileInput.files[0];
    // Reset so the same file can be picked again after a failed decode.
    els.qrFileInput.value = "";
    handleQrFile(file);
});

els.stopScanButton.addEventListener("click", () => stopScan());

// ------------------------------------------------------------------------
// Server URL setting — only visible when "features.serverCard" is true in
// config.json. Persisted in chrome.storage by the service worker.
// ------------------------------------------------------------------------
async function refreshServerUrl() {
    try {
        const res = await sendAction("getServerUrl");
        if (res && res.ok) els.serverUrlInput.value = res.url;
    } catch { /* leave the placeholder */ }
}

els.saveServerButton.addEventListener("click", async () => {
    els.serverSavedBox.classList.add("hidden");
    els.serverErrorBox.classList.add("hidden");
    const res = await sendAction("setServerUrl", { url: els.serverUrlInput.value });
    if (res && res.ok) {
        els.serverSavedBox.textContent = `Server set to ${res.url}`;
        els.serverSavedBox.classList.remove("hidden");
    } else {
        els.serverErrorBox.textContent = (res && res.error) || "Could not save the server URL.";
        els.serverErrorBox.classList.remove("hidden");
    }
});

els.resetServerButton.addEventListener("click", async () => {
    els.serverSavedBox.classList.add("hidden");
    els.serverErrorBox.classList.add("hidden");
    const res = await sendAction("resetServerUrl");
    if (res && res.ok) {
        els.serverUrlInput.value = res.url;
        els.serverSavedBox.textContent = `Server reset to default (${res.url})`;
        els.serverSavedBox.classList.remove("hidden");
    } else {
        els.serverErrorBox.textContent = (res && res.error) || "Could not reset the server URL.";
        els.serverErrorBox.classList.remove("hidden");
    }
});

// ------------------------------------------------------------------------
// Received share (Device B): site list + import / retry.
// ------------------------------------------------------------------------

// Filter text for the received-backup site list, plus the last uiState seen
// (so typing in the search box can re-render the list without a worker round-trip).
let backupSearchQuery = "";

const backupUi = {
    card: $("backupReceivedCard"),
    summary: $("backupReceivedSummary"),
    searchInput: $("backupSearch"),
    siteList: $("backupSiteList"),
    importAllButton: $("importAllButton"),
    dismissButton: $("dismissButton"),
    importError: $("importError"),
    importResult: $("importResult"),
};

function renderReceivedBackup(state) {
    const show = !!state.backupReceived;
    backupUi.card.classList.toggle("hidden", !show);
    if (!show) {
        // Reset the filter so the next share starts unfiltered.
        backupSearchQuery = "";
        if (backupUi.searchInput) backupUi.searchInput.value = "";
        return;
    }

    const q = backupSearchQuery;
    const membersOf = (s) => ((state.backupSiteMembers || {})[s] || []);
    const sites = q
        ? state.backupSites.filter(
              (s) =>
                  s.toLowerCase().includes(q) ||
                  membersOf(s).some((m) => m.toLowerCase().includes(q))
          )
        : state.backupSites;

    backupUi.summary.textContent =
        q && sites.length !== state.backupSites.length
            ? `${sites.length} of ${state.backupSites.length} site(s) match "${backupUi.searchInput.value.trim()}".`
            : `Received ${state.backupCookieCount} cookies from ` +
              `${state.backupSites.length} site(s). Choose what to import:`;

    // Rebuild the site list on each sync (cheap at this size).
    backupUi.siteList.innerHTML = "";
    if (sites.length === 0) {
        const empty = document.createElement("div");
        empty.className = "site-row";
        const label = document.createElement("span");
        label.textContent = q ? "No sites match your search." : "Nothing left to import.";
        empty.appendChild(label);
        backupUi.siteList.appendChild(empty);
        return;
    }
    for (const site of sites) {
        const row = document.createElement("div");
        row.className = "site-row";

        const label = document.createElement("div");
        const nameEl = document.createElement("div");
        nameEl.textContent = site;
        label.appendChild(nameEl);
        const present = membersOf(site).filter((m) => m !== site);
        if (present.length) {
            const hint = document.createElement("div");
            hint.className = "hint";
            hint.style.margin = "0";
            hint.textContent = "includes " + present.join(", ");
            label.appendChild(hint);
        }

        const btn = document.createElement("button");
        btn.className = "secondary";
        btn.textContent = "Import";
        btn.addEventListener("click", () => importReceived([site], btn));

        row.appendChild(label);
        row.appendChild(btn);
        backupUi.siteList.appendChild(row);
    }
}

async function importReceived(domains, button) {
    backupUi.importError.classList.add("hidden");
    backupUi.importResult.classList.add("hidden");
    const original = button ? button.textContent : "";
    if (button) {
        button.disabled = true;
        button.textContent = "Importing…";
    }
    try {
        const res = await sendAction("importReceivedBackup", { domains });
        if (res && res.ok) {
            let message = `Imported ${res.restored} of ${res.total} cookie(s) into this browser.`;
            if (domains !== "all" && res.siteLabels && res.siteLabels.length > 0) {
                message += ` Sites: ${res.siteLabels.join(", ")}.`;
            } else if (domains !== "all" && res.sites && res.sites.length > 0) {
                message += ` Sites: ${res.sites.join(", ")}.`;
            }
            if (res.failures && res.failures.length > 0) {
                message += " Failed: " + res.failures.slice(0, 3).join("; ");
                if (res.failures.length > 3) message += ` (+${res.failures.length - 3} more)`;
            }
            backupUi.importResult.textContent = message;
            backupUi.importResult.classList.remove("hidden");
        } else {
            backupUi.importError.textContent = (res && res.error) || "Import failed.";
            backupUi.importError.classList.remove("hidden");
        }
    } finally {
        // The worker is the source of truth: re-render from it so the card
        // can never show a stale site list after an import.
        refreshState();
        if (button) {
            button.disabled = false;
            button.textContent = original;
        }
    }
}

backupUi.importAllButton.addEventListener("click", (e) =>
    importReceived("all", e.target)
);

backupUi.dismissButton.addEventListener("click", () => {
    sendAction("dismissReceived");
});

backupUi.searchInput.addEventListener("input", (e) => {
    backupSearchQuery = e.target.value.trim().toLowerCase();
    if (lastUiState) renderReceivedBackup(lastUiState);
});

// ------------------------------------------------------------------------
// Admin inbox: shares uploaded to the assigned account (48h, multi-use).
// One tap imports everything — no QR scan needed.
// ------------------------------------------------------------------------
const inboxUi = {
    section: $("inboxSection"),
    list: $("inboxList"),
    refreshButton: $("refreshInboxButton"),
    error: $("inboxError"),
};

function timeAgo(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms) || ms < 0) return "just now";
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function inboxRow(text) {
    const row = document.createElement("div");
    row.className = "site-row";
    const label = document.createElement("span");
    label.textContent = text;
    row.appendChild(label);
    return row;
}

async function refreshInbox() {
    inboxUi.error.classList.add("hidden");
    inboxUi.list.innerHTML = "";
    inboxUi.list.appendChild(inboxRow("Loading…"));
    const res = await sendAction("listAccountShares");
    inboxUi.list.innerHTML = "";
    if (!res || res.ok === false) {
        inboxUi.error.textContent = (res && res.error) || "Could not load incoming shares.";
        inboxUi.error.classList.remove("hidden");
        return;
    }
    if (!res.accountId) {
        inboxUi.list.appendChild(inboxRow("No account configured — set one in config.json."));
        return;
    }
    if (!res.shares.length) {
        inboxUi.list.appendChild(inboxRow("No incoming shares yet."));
        return;
    }
    for (const s of res.shares) {
        const row = document.createElement("div");
        row.className = "site-row";
        const label = document.createElement("div");
        const line = document.createElement("div");
        line.textContent = `${timeAgo(s.createdAt)} — ${s.cookieCount} cookies, ${s.siteCount} sites`;
        label.appendChild(line);
        const btn = document.createElement("button");
        btn.className = "secondary";
        btn.textContent = "Import";
        btn.addEventListener("click", () => importInboxShare(s.id, btn));
        row.appendChild(label);
        row.appendChild(btn);
        inboxUi.list.appendChild(row);
    }
}

async function importInboxShare(shareId, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Importing…";
    inboxUi.error.classList.add("hidden");
    try {
        const res = await sendAction("importAccountShare", { shareId });
        if (!res || res.ok === false) {
            inboxUi.error.textContent = (res && res.error) || "Import failed.";
            inboxUi.error.classList.remove("hidden");
        }
        // Account shares stay listed (multi-use, 48h) — refresh the view.
        refreshInbox();
    } finally {
        button.disabled = false;
        button.textContent = original;
    }
}

els.refreshInboxButton.addEventListener("click", () => refreshInbox());

// ------------------------------------------------------------------------
// Startup: brand first (drives name/colour/visible features), then sync.
// ------------------------------------------------------------------------
refreshServerUrl();
initBrand().finally(() => {
    refreshState();
    if (BRAND.features.inbox) refreshInbox();
});
