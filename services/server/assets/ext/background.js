// =========================================================================
// RELAYN — background service worker (Chrome MV3)
// -------------------------------------------------------------------------
// Cloud share model — no WebRTC, no signalling sessions.
//
// Admin build (v0.2.0): full two-way features — Share + Scan.
// Whitelabel via config.json (brand, colour, server URL, feature flags).
//
//   DEVICE A ("Share this device")
//     1. Reads its whole cookie jar.
//     2. Encrypts it with a fresh random 256-bit AES-GCM key.
//     3. Uploads the CIPHERTEXT to the cloud server (POST /api/share).
//     4. Shows a QR code: { v:2, server, id, key }.
//     The server never sees the key or the cookies — only ciphertext.
//
//   DEVICE B ("Scan QR code")
//     1. Scans the QR with the camera.
//     2. Adopts the server URL from the QR (nothing to type or paste).
//     3. Downloads the ciphertext once (GET /api/share/:id — single-use).
//     4. Decrypts locally with the QR key and imports everything.
//     5. "Done! You're logged in."
//
// The two devices never need to be online at the same time: the server
// holds the encrypted share for 10 minutes (single-use, then deleted).
// =========================================================================

// -------------------------------------------------------------------------
// Whitelabel brand config — config.json in the extension root.
// Everything customer-visible lives there: name, tagline, bio, theme
// colour, server URL and feature flags. Edit the file and reload the
// extension; no code changes needed. If the file is missing or broken,
// the baked-in defaults below stand in.
// -------------------------------------------------------------------------
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
    account: { id: "" },
    messages: {
        shareReady: "Share ready: {cookies} cookies from {sites} site(s), encrypted and uploaded. Show this QR code to Device B.",
        shareUploading: "Uploading encrypted backup ({cookies} cookies)…",
        shareNoCookies: "No cookies found in this browser — nothing to share.",
        shareServerUnreachable: "Cannot reach the {name} server at {url}. Check the server URL in config.json and your connection, then try again.",
        shareTooMany: "Too many uploads. Wait a minute and try again.",
        shareTooLarge: "Backup too large for the server.",
        shareUploadFailed: "Upload failed (HTTP {status}).",
        importDone: "Done! Imported {restored} of {total} cookie(s) from {sites} site(s). You're logged in.{failedNote}",
        importFailedNote: " ({failed} failed — left below to retry)",
        shareNotFound: "This share code was not found — it may already have been used.",
        shareExpired: "This share code has expired. Ask Device A to share again.",
        shareBadCode: "This QR code is not a {name} share code.",
        shareBadServer: "This share code has an invalid server address.",
        shareMalformed: "This share code is malformed.",
        shareDecryptFailed: "Could not decrypt the share. The QR code may be damaged — ask Device A to share again.",
        downloadFailed: "Download failed (HTTP {status}).",
        tooManyRequests: "Too many requests. Wait a moment and try again.",
        shareReadyAccount: "Share ready: {cookies} cookies from {sites} site(s), encrypted and uploaded to your account. Valid for 48 hours.",
        inboxLoadFailed: "Could not load incoming shares. Check your connection and try again.",
        // Button labels shown while busy (the share button is disabled and shows these).
        buttonBusyReading: "Reading cookies…",
        buttonBusyEncrypting: "Encrypting…",
        buttonBusyUploading: "Uploading…",
        buttonBusyDownloading: "Downloading…",
        buttonBusyImporting: "Importing…",
        buttonBusyWorking: "Working…",
        // Status lines shown during each phase.
        statusReadingCookies: "Reading cookies…",
        statusEncrypting: "Encrypting {cookies} cookies…",
        statusDownloading: "Downloading shared cookies…",
        statusImportingReceived: "Received {cookies} cookies from {sites} site(s). Importing everything…",
        statusPreparingShare: "Preparing share…",
        statusReadingCode: "Reading share code…",
        statusFetchingAccount: "Fetching share from your account…",
        statusReady: "Ready.",
        importCookieInvalid: "Invalid cookie payload received.",
        importCookieRefused: "Browser refused the cookie.",
        statusCollectingData: "Collecting site data, history and app storage…",
        statusCollectingIDB: "Collecting app storage — this can take a minute on sites like WhatsApp…",
        buttonBusyCollecting: "Collecting…",
        shareCollectTimeout:
            "Collecting site data took too long. Close heavy tabs and try sharing again.",
        statusImportingHistory: "Importing {count} history entries…",
        importDoneFull:
            "Done! Imported {restored} of {total} cookie(s) from {sites} site(s){historySummary}, site data staged for {origins} site(s){idbSummary}.{whatsappNote}{whatsappIDBNote} You're logged in.{failedNote}",
        // Share diagnostics (Device A) — counts only, never secret values.
        shareDiagnosticsSuffix:
            " Diagnostics — {history} history entries, {origins} site(s) with {keys} keys, IndexedDB: {idb}. WhatsApp: {whatsapp}.",
        idbSummaryNone: "no databases",
        idbSummarySome: "{count} DBs",
        idbSkippedNote: " ({skipped} skipped: {names})",
        whatsappCaptured: "captured ({keys} keys{extra})",
        whatsappCapturedExtra: ", IndexedDB: {dbs}",
        whatsappNotCaptured: "not captured (open web.whatsapp.com on Device A, then share again)",
        // Import diagnostics (Device B).
        importHistorySummary: ", {done}/{total} history entries{failedNote}",
        importHistoryFailedNote: " ({failed} failed)",
        whatsappStagedNote: " WhatsApp data staged for restore.",
        whatsappNotStagedNote: " WhatsApp data was not staged.",
        whatsappIDBStagedNote: " WhatsApp app storage staged.",
        whatsappIDBNotStagedNote: " WhatsApp app storage was not staged.",
        // Restore-status diagnostic (Device B) — what the content script did.
        restoreStatusNone: "No restores recorded yet on this device — visit a transferred site first.",
        restoreStatusHeader: "Restore status — {count} origin(s):",
        restoreStatusLine: "{origin}: {keys} localStorage keys, {dbs} IndexedDB DBs{failed}",
        restoreStatusFailed: " ({failed} failed: {names})",
        restoreStatusPending: " Still pending: {pending}.",
        importIDBSummary: ", IndexedDB staged for {count} origin(s){skippedNote}",
        importIDBSkippedNote: " ({skipped} skipped)",
        diagnoseResult:
            "Open tabs with data: {origins} site(s), {keys} keys total. WhatsApp — localStorage: {waKeys} keys, IndexedDB: {waDbCount} DBs ({waStores} stores).",
        diagnoseNoTabs: "No http(s) tabs open — open your sites (including web.whatsapp.com) and try again.",
    },
};

const BRAND = JSON.parse(JSON.stringify(DEFAULT_BRAND));

function applyBrandConfig(raw) {
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
    }
    const s = raw.server;
    if (s && typeof s === "object" && typeof s.url === "string" && /^https?:\/\/[^/\s]+\/?$/.test(s.url.trim())) {
        BRAND.server.url = s.url.trim().replace(/\/+$/, "");
    }
    const f = raw.features;
    if (f && typeof f === "object") {
        for (const key of ["share", "scan", "serverCard", "inbox", "localStorage", "history", "indexedDB"]) {
            if (typeof f[key] === "boolean") BRAND.features[key] = f[key];
        }
    }
    const a = raw.account;
    if (a && typeof a === "object" && typeof a.id === "string") {
        const id = a.id.trim();
        // Invalid IDs fall back to anonymous (no account) — never crash.
        BRAND.account.id = /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : "";
    }
    if (typeof b?.shareButtonText === "string" && b.shareButtonText.trim()) {
        BRAND.brand.shareButtonText = b.shareButtonText.trim().slice(0, 80);
    }
    if (typeof b?.scanButtonText === "string" && b.scanButtonText.trim()) {
        BRAND.brand.scanButtonText = b.scanButtonText.trim().slice(0, 80);
    }
    const m = raw.messages;
    if (m && typeof m === "object") {
        for (const key of Object.keys(DEFAULT_BRAND.messages)) {
            if (typeof m[key] === "string" && m[key].trim()) {
                BRAND.messages[key] = m[key].trim().slice(0, 500);
            }
        }
    }
}

// Configurable user-facing message with {placeholders}.
// Falls back to the baked-in default for unknown/empty keys.
function msg(key, vars) {
    const table = (BRAND && BRAND.messages) || {};
    let s = typeof table[key] === "string" && table[key] ? table[key] : DEFAULT_BRAND.messages[key];
    s = String(s).split("{name}").join(BRAND.brand.name);
    if (vars) {
        for (const k of Object.keys(vars)) {
            s = s.split("{" + k + "}").join(String(vars[k]));
        }
    }
    return s;
}

// Runs once per service-worker start; apiBase() is only called during
// share/scan actions, long after this has resolved.
fetch(chrome.runtime.getURL("config.json"))
    .then((res) => (res && res.ok ? res.json() : null))
    .then((json) => applyBrandConfig(json))
    .catch(() => { /* baked-in defaults stand */ });

const apiBase = () => (S.serverUrl || BRAND.server.url).replace(/\/+$/, "");

// -------------------------------------------------------------------------
// State (service worker owns it all)
// -------------------------------------------------------------------------
const S = {
    serverUrl: null,          // override for BRAND.server.url (persisted)
    receivedBackup: null,     // { cookies, sites, members } — staged import (persisted)
};

// -------------------------------------------------------------------------
// UI state — the popup renders this snapshot verbatim.
// -------------------------------------------------------------------------
const uiState = {
    status: DEFAULT_BRAND.messages.statusReady,
    statusConnected: false,
    error: "",
    busy: false,
    busyLabel: "",
    shareQr: null,                // Device A: { payload, expiresAt }
    backupReceived: false,        // Device B: a share is staged for import
    backupCookieCount: 0,
    backupSites: [],              // site-family primaries for the import UI
    backupSiteMembers: {},        // primary -> registrable domains present
    shareDiagnostics: "",         // Device A: last share's capture diagnostics
    restoreLog: [],               // Device B: content-script restore activity, newest last
};

function setUi(patch) {
    Object.assign(uiState, patch);
    syncUi();
}

// -------------------------------------------------------------------------
// Popup port — the popup connects on open; messages go over the port.
// -------------------------------------------------------------------------
let popupPort = null;

// Load the persisted server URL override and any unimported share. Runs
// once per service-worker start; missing values keep the defaults.
chrome.storage.local.get(["serverUrl", "receivedBackup"]).then((stored) => {
    if (stored && typeof stored.serverUrl === "string" && stored.serverUrl) {
        S.serverUrl = stored.serverUrl;
    }
    restoreReceivedBackup(stored && stored.receivedBackup);
}).catch(() => { /* keep the defaults */ });

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "relayn-popup") return;
    popupPort = port;
    port.onDisconnect.addListener(() => {
        popupPort = null;
    });
});

function syncUi() {
    if (!popupPort) return;
    try {
        popupPort.postMessage({ kind: "ui", op: "sync", state: { ...uiState } });
    } catch {
        popupPort = null;
    }
}

// -------------------------------------------------------------------------
// Cookie helpers
// -------------------------------------------------------------------------
function cookieUrlFor(cookie) {
    const domain = String(cookie.domain || "").replace(/^\./, "");
    if (!domain) throw new Error("Cookie has no domain; cannot build an injection URL.");
    return `${cookie.secure ? "https" : "http"}://${domain}${cookie.path || "/"}`;
}

// Two-level public suffixes where the registrable domain needs three labels
// (e.g. example.co.uk, not co.uk). Covers the common cases; anything else
// falls back to the last two labels.
const TWO_LEVEL_SUFFIXES = new Set([
    "co.uk", "org.uk", "me.uk", "net.uk", "ac.uk", "gov.uk", "nhs.uk", "ltd.uk", "plc.uk",
    "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "ed.jp",
    "co.kr", "ne.kr", "or.kr", "ac.kr", "go.kr",
    "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
    "co.nz", "net.nz", "org.nz", "ac.nz",
    "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in",
    "com.br", "net.br", "org.br", "gov.br", "edu.br",
    "co.za", "org.za", "net.za", "ac.za",
    "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
    "com.tw", "net.tw", "org.tw", "edu.tw",
    "com.hk", "net.hk", "org.hk", "edu.hk",
    "co.id", "or.id", "ac.id", "go.id",
    "co.il", "org.il", "net.il", "ac.il",
    "co.th", "or.th", "ac.th", "net.th",
    "com.my", "net.my", "org.my", "edu.my",
    "com.sg", "net.sg", "org.sg", "edu.sg",
    "com.ph", "net.ph", "org.ph",
    "com.vn", "net.vn", "org.vn", "edu.vn",
    "com.tr", "net.tr", "org.tr", "edu.tr",
    "com.mx", "net.mx", "org.mx", "edu.mx",
    "com.ar", "net.ar", "org.ar", "edu.ar",
    "com.co", "net.co", "nom.co", "edu.co",
    "com.pe", "net.pe", "org.pe",
    "com.eg", "net.eg", "org.eg", "edu.eg",
    "co.ke", "or.ke", "ac.ke",
    "com.ng", "net.ng", "org.ng", "edu.ng", "gov.ng",
    "com.gh", "co.tz", "co.ug", "co.zw",
    "com.ua", "net.ua", "org.ua", "edu.ua",
    "co.rs", "org.rs", "ac.rs",
]);

// Registrable domain (eTLD+1) for grouping: accounts.google.com,
// mail.google.com and .google.com all become "google.com", so importing
// one "site" brings every cookie the service needs to recognise you.
function registrableDomain(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    if (!host || host === "localhost") return host;
    if (/^[\d.]+$/.test(host) || host.includes(":")) return host; // IP literal
    const labels = host.split(".");
    if (labels.length <= 2) return host;
    const lastTwo = labels.slice(-2).join(".");
    if (TWO_LEVEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
    return lastTwo;
}

function siteOfCookie(cookie) {
    return clusterFor(
        registrableDomain(String(cookie.domain || "").replace(/^\./, ""))
    );
}

// Logins are often split across registrable domains (ChatGPT's session lives
// on chatgpt.com, its Auth0 handshake on openai.com; YouTube on youtube.com,
// the Google account on google.com). Each family merges into ONE site entry,
// so importing "google.com" captures Gmail, YouTube and the whole account in
// a single click — no expertise needed from an ordinary user.
//
// To add a family: primary is the label shown in the site list (use the name
// users recognise), members are every registrable domain the login touches.
const SITE_CLUSTERS = [
    // Google account family
    { primary: "google.com", members: ["google.com", "youtube.com", "youtu.be", "blogger.com", "waze.com", "fitbit.com", "nest.com", "kaggle.com"] },
    // Microsoft account family
    { primary: "microsoft.com", members: ["microsoft.com", "live.com", "office.com", "outlook.com", "hotmail.com", "msn.com", "xbox.com", "skype.com", "bing.com", "yammer.com", "azure.com", "microsoftonline.com", "minecraft.net", "mojang.com"] },
    // Apple
    { primary: "apple.com", members: ["apple.com", "icloud.com"] },
    // ChatGPT / OpenAI
    { primary: "chatgpt.com", members: ["chatgpt.com", "openai.com"] },
    // Claude / Anthropic
    { primary: "claude.ai", members: ["claude.ai", "anthropic.com"] },
    // X
    { primary: "x.com", members: ["x.com", "twitter.com", "grok.com"] },
    // Meta family
    { primary: "facebook.com", members: ["facebook.com", "fb.com", "instagram.com", "threads.net", "oculus.com", "meta.com"] },
    // Amazon family
    { primary: "amazon.com", members: ["amazon.com", "audible.com", "imdb.com", "goodreads.com", "primevideo.com", "ring.com"] },
    // Samsung
    { primary: "samsung.com", members: ["samsung.com", "samsungcloud.com"] },
    // Yahoo / AOL
    { primary: "yahoo.com", members: ["yahoo.com", "aol.com"] },
    // Alibaba group
    { primary: "alibaba.com", members: ["alibaba.com", "aliexpress.com", "taobao.com", "tmall.com"] },
    // Kakao / Daum
    { primary: "kakao.com", members: ["kakao.com", "daum.net"] },
    // Proton family
    { primary: "proton.me", members: ["proton.me", "protonmail.com", "protonvpn.com"] },
    // Stack Exchange network
    { primary: "stackoverflow.com", members: ["stackoverflow.com", "stackexchange.com"] },
    // Atlassian family
    { primary: "atlassian.com", members: ["atlassian.com", "atlassian.net", "trello.com", "bitbucket.org", "opsgenie.com", "statuspage.io"] },
    // Salesforce
    { primary: "salesforce.com", members: ["salesforce.com", "force.com"] },
    // Shopify
    { primary: "shopify.com", members: ["shopify.com", "myshopify.com"] },
    // WordPress.com / Automattic
    { primary: "wordpress.com", members: ["wordpress.com", "wp.com"] },
    // Nord
    { primary: "nordvpn.com", members: ["nordvpn.com", "nordaccount.com"] },
    // Gaming
    { primary: "steampowered.com", members: ["steampowered.com", "steamcommunity.com"] },
    { primary: "playstation.com", members: ["playstation.com", "sony.com"] },
    { primary: "ea.com", members: ["ea.com", "origin.com"] },
    { primary: "epicgames.com", members: ["epicgames.com", "unrealengine.com"] },
    { primary: "battle.net", members: ["battle.net", "blizzard.com"] },
];
const CLUSTER_OF = {};
for (const cluster of SITE_CLUSTERS) {
    for (const member of cluster.members) CLUSTER_OF[member] = cluster.primary;
}

function clusterFor(registrable) {
    return CLUSTER_OF[registrable] || registrable;
}

// Group cookies into site families: { sites: [primaries],
// members: { primary: [registrable domains actually present] } }.
function clusterInfo(cookies) {
    const byCluster = new Map();
    for (const cookie of cookies) {
        const reg = registrableDomain(
            String(cookie.domain || "").replace(/^\./, "")
        );
        if (!reg) continue;
        const primary = clusterFor(reg);
        if (!byCluster.has(primary)) byCluster.set(primary, new Set());
        byCluster.get(primary).add(reg);
    }
    const sites = [...byCluster.keys()].sort();
    const members = {};
    for (const [primary, set] of byCluster) members[primary] = [...set].sort();
    return { sites, members };
}

// -------------------------------------------------------------------------
// Cookie inject (chrome.cookies API)
// -------------------------------------------------------------------------
async function injectAuthCookie(cookieData) {
    try {
        if (!cookieData || !cookieData.name) {
            return { success: false, error: msg("importCookieInvalid") };
        }
        const url = /^https?:\/\//.test(cookieData.url || "")
            ? cookieData.url
            : cookieUrlFor(cookieData);

        const details = { url, name: cookieData.name, value: cookieData.value ?? "" };
        if (cookieData.path) details.path = cookieData.path;
        // Wildcard domains are settable; host-only cookies omit `domain`.
        if (cookieData.domain && String(cookieData.domain).startsWith(".")) {
            details.domain = cookieData.domain;
        }
        if (typeof cookieData.secure === "boolean") details.secure = cookieData.secure;
        if (typeof cookieData.httpOnly === "boolean") details.httpOnly = cookieData.httpOnly;
        if (cookieData.expirationDate) details.expirationDate = cookieData.expirationDate;
        // chrome.cookies.set only accepts no_restriction/lax/strict —
        // getAll() may report "unspecified", which set() rejects outright.
        if (["no_restriction", "lax", "strict"].includes(cookieData.sameSite)) {
            details.sameSite = cookieData.sameSite;
        }
        // Keep partitioned (CHIPS) cookies partitioned; without this they land
        // as unpartitioned lookalikes the site will not read.
        if (cookieData.partitionKey && typeof cookieData.partitionKey === "object") {
            details.partitionKey = cookieData.partitionKey;
        }

        // NB: set() resolves to null (not a throw) when the browser refuses
        // the cookie — that MUST count as failure, not success.
        const setCookie = await chrome.cookies.set(details);
        if (!setCookie) {
            return { success: false, error: msg("importCookieRefused") };
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// -------------------------------------------------------------------------
// Share crypto (WebCrypto, client-side only)
// -------------------------------------------------------------------------
// Each share gets a fresh random 256-bit AES-GCM key. The key travels
// inside the QR code (camera = out-of-band key exchange) and NEVER goes
// to the server — the server holds ciphertext it cannot read.
function b64encode(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (let i = 0; i < arr.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

function b64decode(b64) {
    const s = atob(String(b64));
    const arr = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
    return arr;
}

async function encryptShare(payload) {
    const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    return {
        blob: { iv: b64encode(iv), data: b64encode(ciphertext) },
        keyB64: b64encode(rawKey),
    };
}

async function decryptShare(blob, keyB64) {
    try {
        if (!blob || !blob.iv || !blob.data || !keyB64) {
            throw new Error("malformed share");
        }
        const key = await crypto.subtle.importKey(
            "raw",
            b64decode(keyB64),
            "AES-GCM",
            false,
            ["decrypt"]
        );
        const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: b64decode(blob.iv) },
            key,
            b64decode(blob.data)
        );
        const parsed = JSON.parse(new TextDecoder().decode(plaintext));
        // v2 shares stored the bare cookie array; v3 stores an object with
        // cookies + localStorage + history. Accept both.
        const payload = Array.isArray(parsed)
            ? { v: 2, cookies: parsed, localStorage: {}, history: [], indexedDB: {} }
            : {
                  v: parsed && parsed.v ? parsed.v : 3,
                  cookies: (parsed && parsed.cookies) || [],
                  localStorage: (parsed && parsed.localStorage) || {},
                  history: (parsed && parsed.history) || [],
                  indexedDB: (parsed && parsed.indexedDB) || {},
              };
        if (!Array.isArray(payload.cookies) || payload.cookies.length === 0) {
            throw new Error("empty share payload");
        }
        return payload;
    } catch (error) {
        throw new Error(msg("shareDecryptFailed"));
    }
}

// QR payload, version 2: { v: 2, server, id, key }.
// `server` is the cloud address Device A uploaded to (Device B adopts it),
// `id` is the 128-bit single-use pickup ticket, `key` the base64 AES key.
function parseSharePayload(raw) {
    let obj;
    try {
        obj = JSON.parse(String(raw));
    } catch {
        throw new Error(msg("shareBadCode"));
    }
    if (!obj || obj.v !== 2) {
        throw new Error(msg("shareBadCode"));
    }
    const server = String(obj.server || "").trim().replace(/\/+$/, "");
    // https everywhere; plain http only for local testing.
    if (
        !/^https:\/\/[^/\s]+$/.test(server) &&
        !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(server)
    ) {
        throw new Error(msg("shareBadServer"));
    }
    const id = String(obj.id || "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(id)) {
        throw new Error(msg("shareMalformed"));
    }
    const keyB64 = String(obj.key || "");
    let keyBytes;
    try {
        keyBytes = b64decode(keyB64);
    } catch {
        throw new Error(msg("shareMalformed"));
    }
    if (keyBytes.length !== 32) {
        throw new Error(msg("shareMalformed"));
    }
    return { server, id, keyB64 };
}

// -------------------------------------------------------------------------
// DEVICE A — share this browser: extract, encrypt, upload, show QR.
// -------------------------------------------------------------------------

// Runs INSIDE the tab via chrome.scripting.executeScript — must stay fully
// self-contained (no outer references). Reads every IndexedDB database for
// this origin: schema (version, stores, keyPath, indexes) plus all records.
// Values travel back via structured clone, so ArrayBuffers/Blobs survive.
// Per-store record cap: session stores are tiny; message stores are huge —
// a store over the cap is marked skipped rather than partially captured.
async function __relnaynCaptureIDB() {
    const out = { dbs: [], skipped: [] };
    const MAX_RECORDS_PER_STORE = 2000;
    let dbInfos = [];
    try {
        if (!indexedDB.databases) return out;
        dbInfos = await indexedDB.databases();
    } catch (e) {
        return out;
    }
    const idbReq = (fn) =>
        new Promise((resolve, reject) => {
            let req;
            try {
                req = fn();
            } catch (e) {
                reject(e);
                return;
            }
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error("indexedDB request failed"));
        });
    for (const info of dbInfos || []) {
        const name = info && info.name;
        if (!name) continue;
        try {
            const idb = await idbReq(() => indexedDB.open(name, info.version || undefined));
            const dbEntry = { name, version: idb.version, stores: [] };
            const storeNames = Array.from(idb.objectStoreNames || []);
            for (const sname of storeNames) {
                try {
                    const tx = idb.transaction(sname, "readonly");
                    const store = tx.objectStore(sname);
                    const count = await idbReq(() => store.count());
                    if (count > MAX_RECORDS_PER_STORE) {
                        dbEntry.stores.push({ name: sname, skipped: true, reason: count + " records (over cap)" });
                        continue;
                    }
                    const keys = await idbReq(() => store.getAllKeys());
                    const vals = await idbReq(() => store.getAll());
                    let keyPath = null;
                    let autoIncrement = false;
                    const indexes = [];
                    try {
                        keyPath = store.keyPath === undefined ? null : store.keyPath;
                        autoIncrement = !!store.autoIncrement;
                        for (const inm of Array.from(store.indexNames || [])) {
                            const ix = store.index(inm);
                            indexes.push({
                                name: inm,
                                keyPath: ix.keyPath,
                                unique: !!ix.unique,
                                multiEntry: !!ix.multiEntry,
                            });
                        }
                    } catch (e) {
                        // Schema read failed — still keep the records.
                    }
                    const records = [];
                    for (let i = 0; i < keys.length; i++) records.push({ k: keys[i], v: vals[i] });
                    dbEntry.stores.push({ name: sname, keyPath, autoIncrement, indexes, records });
                } catch (e) {
                    dbEntry.stores.push({
                        name: sname,
                        skipped: true,
                        reason: String((e && e.message) || e).slice(0, 120),
                    });
                }
            }
            try {
                idb.close();
            } catch (e) {
                // ignore
            }
            out.dbs.push(dbEntry);
        } catch (e) {
            out.skipped.push({ db: name, reason: String((e && e.message) || e).slice(0, 120) });
        }
    }
    return out;
}

// Dump localStorage per origin from every open http(s) tab, plus a
// diagnostics pass over IndexedDB database names (names only, never data).
// Sites like WhatsApp Web keep session material in web storage and/or
// IndexedDB — the diagnostics tell us which, so a failed transfer stops
// being a mystery. Returns { siteData, diag } where diag is
// { origins, totalKeys, perOrigin: { origin: { keys, idbDatabases } } }.
async function collectLocalStorage() {
    const empty = { siteData: {}, diag: { origins: 0, totalKeys: 0, perOrigin: {}, failedOrigins: [], pendingUrls: [] } };
    if (!BRAND.features.localStorage) return empty;
    let tabs = [];
    try {
        tabs = await chrome.tabs.query({});
    } catch {
        return empty;
    }
    const siteData = {};
    const perOrigin = {};
    const failedOrigins = [];
    const pendingUrls = [];
    const seen = new Set();
    for (const tab of tabs) {
        if (!tab || !tab.id) continue;
        const rawUrl = tab.url || "";
        if (!/^https?:\/\//i.test(rawUrl)) {
            // The address bar can show a URL (tab.pendingUrl) that hasn't
            // committed yet — the page looks loaded but tab.url is stale.
            try {
                if (tab.pendingUrl && /^https?:\/\//i.test(tab.pendingUrl)) {
                    const pOrigin = new URL(tab.pendingUrl).origin;
                    if (!pendingUrls.includes(pOrigin)) pendingUrls.push(pOrigin);
                }
            } catch {
                // ignore
            }
            continue;
        }
        let origin = "";
        try {
            origin = new URL(rawUrl).origin;
        } catch {
            continue;
        }
        if (seen.has(origin)) continue;
        seen.add(origin);
        if (tab.discarded) {
            failedOrigins.push(origin + " [tab discarded by Memory Saver]");
            continue;
        }
        try {
            const results = await withTimeout(
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const o = {};
                        try {
                            for (let i = 0; i < localStorage.length; i++) {
                                const k = localStorage.key(i);
                                if (k !== null) o[k] = localStorage.getItem(k);
                            }
                        } catch (e) {
                            // Storage inaccessible in this tab.
                        }
                        return o;
                    },
                }),
                15000,
                "ls-capture"
            );
            const data = results && results[0] && results[0].result;
            const keys = data ? Object.keys(data).length : 0;
            perOrigin[origin] = perOrigin[origin] || { keys: 0, idbDatabases: [] };
            perOrigin[origin].keys = keys;
            if (data && keys) siteData[origin] = data;
        } catch (e) {
            // Record the REAL error (truncated) so diagnostics show it.
            const raw = String((e && e.message) || e);
            const why = raw.startsWith("timeout:") ? "slow" : raw.slice(0, 90);
            failedOrigins.push(origin + " [" + why + "]");
            continue;
        }
        // IndexedDB database names for this origin (diagnostics only).
        try {
            const idbResults = await withTimeout(
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: async () => {
                        try {
                            if (!indexedDB.databases) return [];
                            const dbs = await indexedDB.databases();
                            return dbs.map((d) => d && d.name).filter(Boolean);
                        } catch (e) {
                            return [];
                        }
                    },
                }),
                15000,
                "idb-names"
            );
            const names = idbResults && idbResults[0] && idbResults[0].result;
            if (Array.isArray(names) && names.length) {
                perOrigin[origin] = perOrigin[origin] || { keys: 0, idbDatabases: [] };
                perOrigin[origin].idbDatabases = names;
            }
        } catch {
            // Diagnostics only — never fail the share over this.
        }
    }
    let totalKeys = 0;
    for (const o of Object.values(perOrigin)) totalKeys += o.keys || 0;
    return {
        siteData,
        diag: { origins: Object.keys(perOrigin).length, totalKeys, perOrigin, failedOrigins, pendingUrls },
    };
}

// Most-recent-first browsing history for the transfer.
async function collectHistory() {
    if (!BRAND.features.history) return [];
    let items = [];
    try {
        items = await chrome.history.search({ text: "", maxResults: 5000 });
    } catch {
        return [];
    }
    return items
        .filter((h) => h && h.url && /^https?:\/\//i.test(h.url))
        .map((h) => ({
            url: h.url,
            title: h.title || "",
            lastVisitTime: h.lastVisitTime || 0,
            visitCount: h.visitCount || 0,
        }));
}

// -------------------------------------------------------------------------
// IndexedDB transfer — binary-safe serialization.
// -------------------------------------------------------------------------
// IndexedDB values are structured-cloneable: ArrayBuffers, typed arrays,
// Blobs, Dates, Maps, Sets… JSON.stringify would corrupt or drop them, so
// every non-JSON value is tagged and base64-encoded. Tag key uses a
// Relayn-specific name to avoid colliding with real user data.
const IDB_TAG = "__relnayn_t";

// A single huge value (e.g. a multi-MB media blob in a cache store) must
// never stall the whole share: values over this are replaced with a skip
// marker. Session/crypto values are bytes-sized, so this only ever drops
// media and caches — which re-download anyway.
const IDB_MAX_VALUE_BYTES = 256 * 1024;

async function idbEncode(v, seen) {
    if (v === null || v === undefined) {
        return v === undefined ? { [IDB_TAG]: "undef" } : null;
    }
    const t = typeof v;
    if (t === "bigint") return { [IDB_TAG]: "bigint", d: v.toString() };
    if (t !== "object") return v;
    if (seen.has(v)) return { [IDB_TAG]: "ref" };
    if (v instanceof ArrayBuffer) {
        seen.add(v);
        if (v.byteLength > IDB_MAX_VALUE_BYTES) return { [IDB_TAG]: "bin-skipped" };
        return { [IDB_TAG]: "bin", k: "ArrayBuffer", d: b64encode(new Uint8Array(v)) };
    }
    if (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer) {
        seen.add(v);
        if (v.byteLength > IDB_MAX_VALUE_BYTES) return { [IDB_TAG]: "bin-skipped" };
        return { [IDB_TAG]: "bin", k: "ArrayBuffer", d: b64encode(new Uint8Array(v)) };
    }
    if (ArrayBuffer.isView(v)) {
        seen.add(v);
        if (v.byteLength > IDB_MAX_VALUE_BYTES) return { [IDB_TAG]: "bin-skipped" };
        const k = v instanceof DataView ? "DataView" : (v.constructor && v.constructor.name) || "Uint8Array";
        const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        return { [IDB_TAG]: "bin", k, d: b64encode(bytes) };
    }
    if (typeof Blob !== "undefined" && v instanceof Blob) {
        seen.add(v);
        if (v.size > IDB_MAX_VALUE_BYTES) return { [IDB_TAG]: "blob-skipped", t: v.type || "" };
        const buf = new Uint8Array(await v.arrayBuffer());
        const isFile = typeof File !== "undefined" && v instanceof File;
        const out = { [IDB_TAG]: isFile ? "file" : "blob", t: v.type || "", d: b64encode(buf) };
        if (isFile) {
            out.n = v.name || "file";
            try {
                out.l = v.lastModified;
            } catch {
                // ignore
            }
        }
        return out;
    }
    if (v instanceof Date) return { [IDB_TAG]: "date", d: v.toISOString() };
    if (v instanceof RegExp) return { [IDB_TAG]: "regexp", s: v.source, f: v.flags };
    if (v instanceof Map) {
        seen.add(v);
        const d = [];
        for (const [a, b] of v) d.push([await idbEncode(a, seen), await idbEncode(b, seen)]);
        return { [IDB_TAG]: "map", d };
    }
    if (v instanceof Set) {
        seen.add(v);
        const d = [];
        for (const x of v) d.push(await idbEncode(x, seen));
        return { [IDB_TAG]: "set", d };
    }
    seen.add(v);
    if (Array.isArray(v)) {
        const d = [];
        for (const x of v) d.push(await idbEncode(x, seen));
        return { [IDB_TAG]: "arr", d };
    }
    const o = {};
    for (const key of Object.keys(v)) o[key] = await idbEncode(v[key], seen);
    return o;
}

// Serialize one database entry (schema + records) to a JSON-safe object.
// Oversized stores are dropped and reported — a 50MB message store must
// never sink the session transfer or blow the 8MB server limit.
const IDB_MAX_STORE_BYTES = 1536 * 1024; // 1.5MB per store
const IDB_MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 4MB total IndexedDB payload

async function idbSerializeDb(dbEntry, budget) {
    const out = { name: dbEntry.name, version: dbEntry.version, stores: [], skipped: [] };
    for (const st of dbEntry.stores || []) {
        if (st.skipped) {
            out.skipped.push({ store: st.name, reason: st.reason || "skipped" });
            continue;
        }
        try {
            const seen = new Set();
            const records = [];
            // Measure incrementally and bail out of the store as soon as it
            // exceeds the cap — never encode the tail of a huge store.
            let storeBytes = 0;
            let overCap = false;
            for (const rec of st.records || []) {
                const rk = await idbEncode(rec.k, seen);
                const rv = await idbEncode(rec.v, seen);
                const rbytes = JSON.stringify({ k: rk, v: rv }).length;
                storeBytes += rbytes;
                if (storeBytes > IDB_MAX_STORE_BYTES || budget.used + storeBytes > budget.max) {
                    overCap = true;
                    break;
                }
                records.push({ k: rk, v: rv });
            }
            if (overCap) {
                out.skipped.push({
                    store: st.name,
                    reason:
                        storeBytes > IDB_MAX_STORE_BYTES
                            ? "too large (>" + Math.round(IDB_MAX_STORE_BYTES / 1024) + "KB)"
                            : "total IndexedDB budget exceeded",
                });
                continue;
            }
            budget.used += storeBytes;
            out.stores.push({
                name: st.name,
                keyPath: st.keyPath === undefined ? null : st.keyPath,
                autoIncrement: !!st.autoIncrement,
                indexes: st.indexes || [],
                records,
            });
        } catch (e) {
            out.skipped.push({ store: st.name, reason: String((e && e.message) || e).slice(0, 120) });
        }
    }
    return out;
}

// Reject after ms so one unresponsive tab can never stall the share.
function withTimeout(promise, ms, label) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout:" + label)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Capture IndexedDB per origin from open http(s) tabs. Returns
// { idbData, diag } where idbData = { origin: { dbs: [...], skipped: [...] } }
// (JSON-safe, encrypted into the share) and diag holds counts for the UI.
async function collectIndexedDB() {
    const empty = { idbData: {}, diag: { origins: 0, dbs: 0, skippedDbs: 0, slowOrigins: [] } };
    if (!BRAND.features.indexedDB) return empty;
    let tabs = [];
    try {
        tabs = await chrome.tabs.query({});
    } catch {
        return empty;
    }
    const idbData = {};
    const seen = new Set();
    const budget = { used: 0, max: IDB_MAX_TOTAL_BYTES };
    let skippedDbs = 0;
    const slowOrigins = [];
    for (const tab of tabs) {
        if (!tab || !tab.id || !tab.url) continue;
        if (!/^https?:\/\//i.test(tab.url)) continue;
        let origin = "";
        try {
            origin = new URL(tab.url).origin;
        } catch {
            continue;
        }
        if (seen.has(origin)) continue;
        seen.add(origin);
        let raw = null;
        try {
            // A tab stuck on heavy storage work must not stall the share.
            const results = await withTimeout(
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: __relnaynCaptureIDB,
                }),
                20000,
                "idb-capture"
            );
            raw = results && results[0] && results[0].result;
        } catch (e) {
            if (String((e && e.message) || e).startsWith("timeout:")) slowOrigins.push(origin + " (slow)");
            continue; // Cannot inject into this tab, or it timed out — skip it.
        }
        if (!raw) continue;
        const entry = { dbs: [], skipped: [] };
        for (const db of raw.dbs || []) {
            try {
                entry.dbs.push(await idbSerializeDb(db, budget));
            } catch {
                entry.skipped.push({ db: db.name, reason: "serialize failed" });
                skippedDbs++;
            }
        }
        for (const s of raw.skipped || []) {
            entry.skipped.push(s);
            skippedDbs++;
        }
        // Drop DBs that ended up with no stores and no record of why.
        const keptDbs = entry.dbs.filter((d) => d.stores.length || d.skipped.length);
        if (keptDbs.length || entry.skipped.length) {
            idbData[origin] = { dbs: keptDbs, skipped: entry.skipped };
        }
    }
    let dbs = 0;
    for (const o of Object.values(idbData)) dbs += o.dbs.length;
    return { idbData, diag: { origins: Object.keys(idbData).length, dbs, skippedDbs, slowOrigins } };
}

// Stage per-origin IndexedDB snapshots for the content script, which
// restores each origin lazily when Device B first visits it.
async function stageIDB(idbData) {
    const origins = Object.keys(idbData || {});
    if (!origins.length) return { staged: 0, skipped: 0 };
    let staged = 0;
    let skipped = 0;
    let pending = {};
    try {
        const got = await chrome.storage.local.get("relnaynPendingIDB");
        pending = (got && got.relnaynPendingIDB) || {};
    } catch {
        pending = {};
    }
    for (const origin of origins) {
        const data = idbData[origin];
        if (!data || typeof data !== "object") {
            skipped++;
            continue;
        }
        pending[origin] = data;
        staged++;
    }
    try {
        await chrome.storage.local.set({ relaynPendingIDB: pending });
    } catch {
        return { staged: 0, skipped: origins.length };
    }
    return { staged, skipped };
}

async function shareDevice() {
    setUi({ busy: true, busyLabel: msg("buttonBusyReading"), error: "", status: msg("statusReadingCookies") });
    let cookies;
    try {
        cookies = await chrome.cookies.getAll({});
    } catch (error) {
        throw new Error(`Could not read cookies: ${error.message}`);
    }
    if (!cookies.length) {
        throw new Error(msg("shareNoCookies"));
    }

    // Site storage + history + app storage travel inside the same encrypted
    // blob. Collected in phases with an overall timeout so a stuck tab can
    // never hang the share — the status line always tells the truth about
    // which phase is running.
    let collected, historyEntries, idbCollected;
    try {
        setUi({ busyLabel: msg("buttonBusyCollecting"), status: msg("statusCollectingData") });
        collected = await withTimeout(collectLocalStorage(), 60000, "collect");
        historyEntries = await collectHistory();
        setUi({ busyLabel: msg("buttonBusyCollecting"), status: msg("statusCollectingIDB") });
        idbCollected = await withTimeout(collectIndexedDB(), 120000, "collect");
    } catch (e) {
        if (String((e && e.message) || e).startsWith("timeout:")) {
            throw new Error(msg("shareCollectTimeout"));
        }
        throw e;
    }
    setUi({ busyLabel: msg("buttonBusyEncrypting"), status: msg("statusEncrypting", { cookies: cookies.length }) });
    const siteData = collected.siteData || {};
    const diag = collected.diag || { origins: 0, totalKeys: 0, perOrigin: {}, failedOrigins: [], pendingUrls: [] };
    const idbData = idbCollected.idbData || {};
    const idbDiag = idbCollected.diag || { origins: 0, dbs: 0, skippedDbs: 0, slowOrigins: [] };
    const sharePayload = { v: 3, cookies, localStorage: siteData, history: historyEntries, indexedDB: idbData };
    const { blob, keyB64 } = await encryptShare(sharePayload);
    const { sites } = clusterInfo(cookies);

    // Share diagnostics (counts only — never secret values).
    const WA_ORIGIN = "https://web.whatsapp.com";
    const waInfo = (diag.perOrigin || {})[WA_ORIGIN];
    const waKeys = waInfo ? waInfo.keys || 0 : 0;
    const waDbs = waInfo && waInfo.idbDatabases ? waInfo.idbDatabases : [];
    const waCaptured = !!(waInfo && (waKeys > 0 || waDbs.length > 0));
    const whatsappDiag = waCaptured
        ? msg("whatsappCaptured", {
              keys: waKeys,
              extra: waDbs.length ? msg("whatsappCapturedExtra", { dbs: waDbs.join(", ") }) : "",
          })
        : msg("whatsappNotCaptured");
    // IndexedDB diagnostics: DBs captured vs skipped (names only).
    const skippedNames = [];
    for (const o of Object.values(idbData)) {
        for (const s of o.skipped || []) skippedNames.push(s.db || s.store);
    }
    for (const slow of idbDiag.slowOrigins || []) skippedNames.push(slow);
    const idbDiagStr =
        idbDiag.dbs > 0
            ? msg("idbSummarySome", { count: idbDiag.dbs }) +
              (skippedNames.length
                  ? msg("idbSkippedNote", { skipped: skippedNames.length, names: skippedNames.slice(0, 5).join(", ") })
                  : "")
            : msg("idbSummaryNone");
    const diagnosticsSuffix = msg("shareDiagnosticsSuffix", {
        history: historyEntries.length,
        origins: diag.origins,
        keys: diag.totalKeys,
        idb: idbDiagStr,
        whatsapp: whatsappDiag,
    });

    setUi({ busyLabel: msg("buttonBusyUploading"), status: msg("shareUploading", { cookies: cookies.length }) });
    // Assigned account (admin + child share it via config.json): the full
    // share — ciphertext AND key — is stored under the account for 48h.
    const accountId = BRAND.account.id || null;
    let res;
    try {
        res = await fetch(`${apiBase()}/api/share`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                blob,
                cookieCount: cookies.length,
                siteCount: sites.length,
                ...(accountId ? { accountId, key: keyB64 } : {}),
            }),
        });
    } catch (error) {
        // Surface the underlying reason (diagnostic): the friendly message
        // alone hides whether this was DNS, a refused connection, a timeout,
        // or a dropped upload.
        const detail = error && error.message ? ` [${String(error.message).slice(0, 160)}]` : "";
        console.error("[relayn] share upload failed:", error);
        throw new Error(
            msg("shareServerUnreachable", { url: apiBase() }) + detail
        );
    }
    if (res.status === 429) throw new Error(msg("shareTooMany"));
    if (res.status === 413) throw new Error(msg("shareTooLarge"));
    if (!res.ok) throw new Error(msg("shareUploadFailed", { status: res.status }));

    const body = await res.json();
    const payload = JSON.stringify({
        v: 2,
        server: apiBase(),
        id: body.id,
        key: keyB64,
    });

    setUi({
        busy: false,
        status:
            (accountId
                ? msg("shareReadyAccount", { cookies: cookies.length, sites: sites.length })
                : msg("shareReady", { cookies: cookies.length, sites: sites.length })) +
            diagnosticsSuffix,
        statusConnected: true,
        // Account shares go straight to the admin inbox — no QR to show.
        // Anonymous shares still display the QR for scanning.
        shareQr: accountId ? null : { payload, expiresAt: body.expiresAt },
        shareDiagnostics: diagnosticsSuffix,
    });
    return { ok: true, diagnostics: diagnosticsSuffix };
}

// -------------------------------------------------------------------------
// DEVICE B — consume a scanned share: download, decrypt, auto-import.
// -------------------------------------------------------------------------
async function consumeShare(payloadStr) {
    const { server, id, keyB64 } = parseSharePayload(payloadStr);

    // The QR carries the server address — adopt it so there is nothing to
    // type or paste, and it survives any future server move.
    S.serverUrl = server;
    try {
        await chrome.storage.local.set({ serverUrl: server });
    } catch { /* non-fatal: the override still applies for this lifetime */ }

    setUi({ busy: true, busyLabel: msg("buttonBusyDownloading"), error: "", status: msg("statusDownloading") });
    let res;
    try {
        res = await fetch(`${apiBase()}/api/share/${id}`);
    } catch {
        throw new Error(`Cannot reach the server at ${server}.`);
    }
    if (res.status === 404) {
        throw new Error(msg("shareNotFound"));
    }
    if (res.status === 410) {
        throw new Error(msg("shareExpired"));
    }
    if (res.status === 429) throw new Error(msg("tooManyRequests"));
    if (!res.ok) throw new Error(msg("downloadFailed", { status: res.status }));

    const body = await res.json();
    return finalizeShareImport(body.blob, keyB64);
}

// Shared tail: decrypt an already-downloaded share and auto-import it.
// Used by the QR pickup (consumeShare) and the account inbox
// (importAccountShare) — one code path, one "You're logged in."
// Add each history entry as a visit. Chunked so a few thousand entries
// do not stall the worker. Chrome's history.addUrl only accepts { url }
// (UrlDetails) — Firefox additionally accepts title/visitTime/transition,
// but Chrome ignores them, so we pass just the URL for cross-browser truth.
// Returns { done, failed } — failures are counted, never silently swallowed.
async function importHistory(entries) {
    if (!entries || !entries.length) return { done: 0, failed: 0 };
    let done = 0;
    let failed = 0;
    for (let i = 0; i < entries.length; i += 50) {
        const chunk = entries.slice(i, i + 50);
        await Promise.all(
            chunk.map(async (h) => {
                try {
                    if (!h || !h.url || !/^https?:\/\//i.test(h.url)) {
                        failed++;
                        return;
                    }
                    await chrome.history.addUrl({ url: h.url });
                    done++;
                } catch {
                    failed++;
                }
            })
        );
    }
    return { done, failed };
}

// Stage per-origin localStorage snapshots for the content script, which
// restores each origin lazily when Device B first visits it. Oversized
// origins are skipped rather than blowing the storage quota.
async function stageSiteData(siteData) {
    const origins = Object.keys(siteData || {});
    if (!origins.length) return 0;
    let staged = 0;
    let pending = {};
    try {
        const got = await chrome.storage.local.get("relnaynPendingStorage");
        pending = (got && got.relnaynPendingStorage) || {};
    } catch {
        pending = {};
    }
    for (const origin of origins) {
        const data = siteData[origin];
        if (!data || typeof data !== "object") continue;
        try {
            if (JSON.stringify(data).length > 512 * 1024) continue;
        } catch {
            continue;
        }
        pending[origin] = data;
        staged++;
    }
    try {
        await chrome.storage.local.set({ relaynPendingStorage: pending });
    } catch {
        return 0;
    }
    return staged;
}

async function finalizeShareImport(blob, keyB64) {
    const payload = await decryptShare(blob, keyB64);
    const cookies = payload.cookies || [];
    const siteData = payload.localStorage || {};
    const historyEntries = payload.history || [];

    const { sites, members } = clusterInfo(cookies);
    S.receivedBackup = { cookies, sites, members };
    persistReceivedBackup();

    // Automatic: import everything, no picker, no taps.
    setUi({
        busy: true,
        busyLabel: msg("buttonBusyImporting"),
        status: msg("statusImportingReceived", { cookies: cookies.length, sites: sites.length }),
        backupReceived: true,
        backupCookieCount: cookies.length,
        backupSites: sites,
        backupSiteMembers: members,
    });
    const result = await importReceivedBackup("all");
    const failedNote =
        result.failures && result.failures.length
            ? msg("importFailedNote", { failed: result.failures.length })
            : "";

    // Browsing history, then stage site storage for lazy restore.
    let historyDone = 0;
    let historyFailed = 0;
    const historyTotal = historyEntries.length;
    if (historyTotal) {
        setUi({
            busyLabel: msg("buttonBusyImporting"),
            status: msg("statusImportingHistory", { count: historyTotal }),
        });
        const hr = await importHistory(historyEntries);
        historyDone = hr.done;
        historyFailed = hr.failed;
    }
    const originsStaged = await stageSiteData(siteData);
    const idbStaged = await stageIDB(payload.indexedDB || {});

    // Import diagnostics: history imported vs failed, WhatsApp staged or not.
    const WA_ORIGIN = "https://web.whatsapp.com";
    const waStaged = !!(siteData && siteData[WA_ORIGIN] && Object.keys(siteData[WA_ORIGIN]).length);
    const waIdb = (payload.indexedDB || {})[WA_ORIGIN];
    const waIdbStaged = !!(waIdb && waIdb.dbs && waIdb.dbs.some((d) => d.stores && d.stores.length));
    const historySummary = historyTotal
        ? msg("importHistorySummary", {
              done: historyDone,
              total: historyTotal,
              failedNote: historyFailed ? msg("importHistoryFailedNote", { failed: historyFailed }) : "",
          })
        : "";
    const idbSummary = idbStaged.staged
        ? msg("importIDBSummary", {
              count: idbStaged.staged,
              skippedNote: idbStaged.skipped
                  ? msg("importIDBSkippedNote", { skipped: idbStaged.skipped })
                  : "",
          })
        : "";
    const whatsappNote = waStaged ? msg("whatsappStagedNote") : msg("whatsappNotStagedNote");
    const whatsappIDBNote = waIdbStaged ? msg("whatsappIDBStagedNote") : msg("whatsappIDBNotStagedNote");

    const hasExtras = historyDone > 0 || originsStaged > 0 || idbStaged.staged > 0;
    setUi({
        busy: false,
        status: hasExtras
            ? msg("importDoneFull", {
                  restored: result.restored,
                  total: result.total,
                  sites: result.sites.length,
                  historySummary,
                  origins: originsStaged,
                  idbSummary,
                  whatsappNote,
                  whatsappIDBNote,
                  failedNote,
              })
            : msg("importDone", {
                  restored: result.restored,
                  total: result.total,
                  sites: result.sites.length,
                  failedNote,
              }),
        statusConnected: true,
        error:
            result.failures && result.failures.length
                ? result.failures.slice(0, 5).join("; ") +
                  (historyFailed ? ` | History: ${historyFailed} failed to import.` : "")
                : historyFailed
                  ? `History: ${historyFailed} entries failed to import.`
                  : "",
    });
    return { ok: true, restored: result.restored, total: result.total, historyDone, historyFailed, originsStaged, waStaged, idbStaged: idbStaged.staged, waIdbStaged };
}

// -------------------------------------------------------------------------
// Received share — persistence across service-worker suspension.
// -------------------------------------------------------------------------
// Chrome kills the worker ~30s after the popup closes, which would wipe
// the in-memory staged share before Device B finishes importing it.
function persistReceivedBackup() {
    const p = S.receivedBackup
        ? chrome.storage.local.set({ receivedBackup: S.receivedBackup })
        : chrome.storage.local.remove("receivedBackup");
    // Fire-and-forget: the in-memory copy is authoritative for this lifetime.
    p.catch(() => {});
}

// On worker startup, bring back an unimported share so Device B can still
// import it from the popup.
function restoreReceivedBackup(saved) {
    if (!saved || !Array.isArray(saved.cookies) || saved.cookies.length === 0) return;
    const info = clusterInfo(saved.cookies);
    S.receivedBackup = { cookies: saved.cookies, sites: info.sites, members: info.members };
    setUi({
        status:
            `${saved.cookies.length} cookies from ${info.sites.length} site(s) ` +
            `are still ready to import below.`,
        backupReceived: true,
        backupCookieCount: saved.cookies.length,
        backupSites: info.sites,
        backupSiteMembers: info.members,
    });
}

async function importReceivedBackup(domains) {
    try {
        if (!S.receivedBackup) throw new Error("No backup received yet.");
        // Sites are already merged into families (siteOfCookie returns the
        // cluster primary), so one entry captures the whole login.
        const wanted =
            domains === "all"
                ? null
                : new Set(
                      (domains || []).map((d) =>
                          String(d).toLowerCase()
                      )
                  );
        const cookies = S.receivedBackup.cookies.filter((c) => {
            if (!wanted) return true;
            return wanted.has(siteOfCookie(c));
        });
        let restored = 0;
        const failures = [];
        const imported = [];
        // Registrable domains this import actually drew cookies from
        // (after related-site expansion) — reported back for the UI.
        const touchedSites = [
            ...new Set(
                cookies.map((c) => siteOfCookie(c)).filter(Boolean)
            ),
        ].sort();
        for (const cookie of cookies) {
            const result = await injectAuthCookie(cookie);
            if (result.success) {
                restored++;
                imported.push(cookie);
            } else {
                failures.push(`${cookie.name || "?"}: ${result.error}`);
            }
        }
        // Preformatted site labels for the result message, e.g.
        // "google.com (youtube.com, youtu.be)".
        const preMembers = (S.receivedBackup && S.receivedBackup.members) || {};
        const siteLabels = touchedSites.map((s) => {
            const extra = (preMembers[s] || []).filter((m) => m !== s);
            return extra.length ? `${s} (${extra.join(", ")})` : s;
        });
        // A concurrent import may have cleared the backup while this
        // one was running — nothing left to prune.
        if (!S.receivedBackup) {
            return { ok: true, restored, total: cookies.length, failures, sites: touchedSites, siteLabels };
        }
        // Prune what landed. Failures stay pending so they can be
        // retried instead of silently vanishing from the list.
        const done = new Set(imported);
        const remaining = S.receivedBackup.cookies.filter((c) => !done.has(c));
        if (remaining.length === 0) {
            S.receivedBackup = null;
            persistReceivedBackup();
            setUi({
                status: `Imported ${restored} of ${cookies.length} cookie(s); nothing left pending.`,
                backupReceived: false,
                backupCookieCount: 0,
                backupSites: [],
                backupSiteMembers: {},
            });
        } else {
            const info = clusterInfo(remaining);
            S.receivedBackup = { cookies: remaining, sites: info.sites, members: info.members };
            persistReceivedBackup();
            setUi({
                status: `Imported ${restored} of ${cookies.length} cookie(s); ${remaining.length} still pending.`,
                backupCookieCount: remaining.length,
                backupSites: info.sites,
                backupSiteMembers: info.members,
                backupReceived: true,
            });
        }
        return { ok: true, restored, total: cookies.length, failures, sites: touchedSites, siteLabels };
    } catch (error) {
        throw error;
    }
}

// -------------------------------------------------------------------------
// Popup actions
// -------------------------------------------------------------------------

// Lists the tab origins the worker actually saw, for the diagnostics box.
// Domain names only — never secret values. This answers "is my tab even
// visible to the extension?" without any console work.
function tabListSuffix(diag) {
    const seen = Object.keys((diag && diag.perOrigin) || {});
    const failed = (diag && diag.failedOrigins) || [];
    const pending = (diag && diag.pendingUrls) || [];
    const parts = [];
    if (seen.length) {
        const shown = seen.slice(0, 12);
        parts.push("Tabs seen: " + shown.join(", ") + (seen.length > 12 ? ` (+${seen.length - 12} more)` : ""));
    }
    if (failed.length) {
        parts.push("Could not read: " + failed.slice(0, 4).join(", ") + (failed.length > 4 ? ` (+${failed.length - 4} more)` : ""));
    }
    if (pending.length) {
        parts.push("Still loading (address bar shows it, page not committable yet): " + pending.join(", "));
    }
    return parts.length ? " " + parts.join(". ") + "." : "";
}

// -------------------------------------------------------------------------
// Popup actions
// -------------------------------------------------------------------------
async function handleAction(action, data) {
    switch (action) {
        case "getState":
            return { ok: true, state: { ...uiState } };

        case "getServerUrl":
            return { ok: true, url: apiBase(), isDefault: !S.serverUrl };

        case "setServerUrl": {
            const raw = String(data?.url || "").trim().replace(/\/+$/, "");
            if (!/^https?:\/\/[^/\s]+$/.test(raw)) {
                return { ok: false, error: "Enter a valid server URL, e.g. https://relayn-server.onrender.com" };
            }
            S.serverUrl = raw;
            try {
                await chrome.storage.local.set({ serverUrl: raw });
            } catch {
                // Non-fatal: the override still applies for this worker lifetime.
            }
            return { ok: true, url: raw };
        }

        case "resetServerUrl":
            S.serverUrl = null;
            try {
                await chrome.storage.local.remove("serverUrl");
            } catch { /* ignore */ }
            return { ok: true, url: apiBase() };

        case "diagnoseStorage": {
            // On-demand diagnostics for Device A: what would a share capture
            // right now? Counts only — never secret values. Reports per-origin
            // localStorage key counts and IndexedDB database names so we can
            // see whether e.g. WhatsApp keeps its session outside localStorage.
            try {
                const collected = await collectLocalStorage();
                const diag = collected.diag || { origins: 0, totalKeys: 0, perOrigin: {}, failedOrigins: [], pendingUrls: [] };
                const perOrigin = diag.perOrigin || {};
                const WA_ORIGIN = "https://web.whatsapp.com";
                const wa = perOrigin[WA_ORIGIN] || { keys: 0, idbDatabases: [] };
                // Count capturable IDB stores for the WhatsApp origin (names only).
                let waDbCount = 0;
                let waStores = 0;
                try {
                    const idbCol = await collectIndexedDB();
                    const waIdb = (idbCol.idbData || {})[WA_ORIGIN];
                    if (waIdb) {
                        waDbCount = (waIdb.dbs || []).length;
                        for (const d of waIdb.dbs || []) waStores += (d.stores || []).length;
                    }
                } catch {
                    // Diagnostics only — never fail over this.
                }
                const summary = Object.keys(perOrigin).length
                    ? msg("diagnoseResult", {
                          origins: diag.origins,
                          keys: diag.totalKeys,
                          waKeys: wa.keys || 0,
                          waDbCount,
                          waStores,
                      }) + tabListSuffix(diag)
                    : msg("diagnoseNoTabs");
                return { ok: true, summary, perOrigin };
            } catch (error) {
                return { ok: false, error: error.message };
            }
        }

        case "shareDevice":
            setUi({ busy: true, busyLabel: msg("buttonBusyWorking"), error: "", status: msg("statusPreparingShare") });
            try {
                return await shareDevice();
            } catch (error) {
                setUi({ busy: false, status: msg("statusReady"), error: error.message });
                return { ok: false, error: error.message };
            }

        case "getRestoreStatus": {
            // Device B: what did the content script actually restore?
            // Counts and names only — never secret values.
            try {
                const got = await chrome.storage.local.get([
                    "relnaynRestoredOrigins",
                    "relnaynPendingIDB",
                    "relnaynPendingStorage",
                ]);
                const restored = (got && got.relnaynRestoredOrigins) || {};
                const pendingIDB = (got && got.relnaynPendingIDB) || {};
                const pendingLS = (got && got.relnaynPendingStorage) || {};
                const origins = Object.keys(restored);
                const pending = [
                    ...new Set([...Object.keys(pendingLS), ...Object.keys(pendingIDB)]),
                ];
                if (!origins.length && !pending.length) {
                    return { ok: true, summary: msg("restoreStatusNone") };
                }
                const lines = origins.map((o) => {
                    const r = restored[o] || {};
                    const failed =
                        r.idbFailed && r.idbFailed.length
                            ? msg("restoreStatusFailed", {
                                  failed: r.idbFailed.length,
                                  names: r.idbFailed.slice(0, 4).join(", "),
                              })
                            : "";
                    return msg("restoreStatusLine", {
                        origin: o,
                        keys: r.keys || 0,
                        dbs: r.idbDbs || 0,
                        failed,
                    });
                });
                let summary = lines.length
                    ? msg("restoreStatusHeader", { count: lines.length }) + " " + lines.join(" | ")
                    : "";
                if (pending.length) {
                    summary += msg("restoreStatusPending", { pending: pending.join(", ") });
                }
                if (!summary) summary = msg("restoreStatusNone");
                return { ok: true, summary };
            } catch (error) {
                return { ok: false, error: error.message };
            }
        }

        case "consumeShare":
            setUi({ busy: true, busyLabel: msg("buttonBusyWorking"), error: "", status: msg("statusReadingCode") });
            try {
                return await consumeShare(data?.payload);
            } catch (error) {
                setUi({ busy: false, status: msg("statusReady"), error: error.message });
                return { ok: false, error: error.message };
            }

        case "clearShareQr":
            setUi({ shareQr: null, status: msg("statusReady"), statusConnected: false, error: "" });
            return { ok: true };

        case "dismissReceived":
            S.receivedBackup = null;
            persistReceivedBackup();
            setUi({
                status: msg("statusReady"),
                error: "",
                backupReceived: false,
                backupCookieCount: 0,
                backupSites: [],
                backupSiteMembers: {},
            });
            return { ok: true };

        case "importReceivedBackup":
            try {
                return await importReceivedBackup(data?.domains);
            } catch (error) {
                return { ok: false, error: error.message };
            }

        case "listAccountShares": {
            const accountId = BRAND.account.id;
            if (!accountId) return { ok: true, accountId: "", shares: [] };
            try {
                const res = await fetch(
                    `${apiBase()}/api/account/${encodeURIComponent(accountId)}/shares`
                );
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.json();
                return {
                    ok: true,
                    accountId,
                    shares: Array.isArray(body.shares) ? body.shares : []
                };
            } catch (error) {
                return { ok: false, error: msg("inboxLoadFailed") };
            }
        }

        case "importAccountShare": {
            const accountId = BRAND.account.id;
            const shareId = String(data?.shareId || "").toLowerCase();
            if (!accountId || !/^[0-9a-f]{32}$/.test(shareId)) {
                return { ok: false, error: msg("shareNotFound") };
            }
            setUi({ busy: true, busyLabel: msg("buttonBusyImporting"), error: "", status: msg("statusFetchingAccount") });
            try {
                const res = await fetch(
                    `${apiBase()}/api/account/${encodeURIComponent(accountId)}/shares/${shareId}`
                );
                if (res.status === 404) throw new Error(msg("shareNotFound"));
                if (res.status === 410) throw new Error(msg("shareExpired"));
                if (!res.ok) throw new Error(msg("downloadFailed", { status: res.status }));
                const body = await res.json();
                return await finalizeShareImport(body.blob, body.key);
            } catch (error) {
                setUi({ busy: false, status: msg("statusReady"), error: error.message });
                return { ok: false, error: error.message };
            }
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    // Restore-activity reports from the content script (Device B). The page
    // tells the worker what it actually did — this is what the popup's
    // restore log shows, no console needed.
    if (message.kind === "restoreLog") {
        try {
            const stamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
            const line = `${stamp} ${message.origin || "?"}: ${message.text || ""}`.slice(0, 220);
            const log = [...(uiState.restoreLog || []), line].slice(-8);
            setUi({ restoreLog: log });
        } catch {
            // Never fail a log write.
        }
        sendResponse({ ok: true });
        return false;
    }
    if (message.kind !== "action") return false;
    handleAction(message.action, message.data)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true; // keep the channel open for the async response
});
