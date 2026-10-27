// =========================================================================
// RELAYN EXT: the extension pair's default config.json.
//
// Ported verbatim from the shipped extension pair artifact
// (relayn-extension-admin-latest.zip, config.json) whose shape is the
// one the extension code itself defines: background.js DEFAULT_BRAND
// plus applyBrandConfig. The two _comment keys in the shipped file
// are documentation only and are not carried here. Role differences
// between the child and admin builds live in features: the child is
// share-only, the admin adds scan and inbox; buildExtConfig in
// ext-console.ts applies that per side.
// =========================================================================

export const EXT_DEFAULT_CONFIG = {
  "brand": {
    "name": "Relayn",
    "tagline": "Move your logins to another device",
    "bio": "Move your logins to another device: share this browser via an encrypted QR code, scan it on the other device, done.",
    "primaryColor": "#1a73e8",
    "successBackground": "#e6f4ea",
    "successColor": "#137333",
    "shareButtonText": "\ud83d\udce4 Share this device",
    "scanButtonText": "\ud83d\udcf7 Scan QR code"
  },
  "server": {
    "url": "https://relayn-server.onrender.com"
  },
  "features": {
    "share": true,
    "scan": true,
    "serverCard": false,
    "inbox": true,
    "localStorage": true,
    "history": true,
    "indexedDB": true
  },
  "messages": {
    "shareReady": "Share ready: {cookies} cookies from {sites} site(s), encrypted and uploaded. Show this QR code to Device B.",
    "shareUploading": "Uploading encrypted backup ({cookies} cookies)\u2026",
    "shareNoCookies": "No cookies found in this browser \u2014 nothing to share.",
    "shareServerUnreachable": "Cannot reach the {name} server at {url}. Check the server URL in config.json and your connection, then try again.",
    "shareTooMany": "Too many uploads. Wait a minute and try again.",
    "shareTooLarge": "Backup too large for the server.",
    "shareUploadFailed": "Upload failed (HTTP {status}).",
    "importDone": "Done! Imported {restored} of {total} cookie(s) from {sites} site(s). You're logged in.{failedNote}",
    "importFailedNote": " ({failed} failed \u2014 left below to retry)",
    "shareNotFound": "This share code was not found \u2014 it may already have been used.",
    "shareExpired": "This share code has expired. Ask Device A to share again.",
    "shareBadCode": "This QR code is not a {name} share code.",
    "shareBadServer": "This share code has an invalid server address.",
    "shareMalformed": "This share code is malformed.",
    "shareDecryptFailed": "Could not decrypt the share. The QR code may be damaged \u2014 ask Device A to share again.",
    "downloadFailed": "Download failed (HTTP {status}).",
    "tooManyRequests": "Too many requests. Wait a moment and try again.",
    "shareReadyAccount": "Share ready: {cookies} cookies from {sites} site(s), encrypted and uploaded to your account. Valid for 48 hours.",
    "inboxLoadFailed": "Could not load incoming shares. Check your connection and try again.",
    "buttonBusyReading": "Reading cookies\u2026",
    "buttonBusyEncrypting": "Encrypting\u2026",
    "buttonBusyUploading": "Uploading\u2026",
    "buttonBusyDownloading": "Downloading\u2026",
    "buttonBusyImporting": "Importing\u2026",
    "buttonBusyWorking": "Working\u2026",
    "statusReadingCookies": "Reading cookies\u2026",
    "statusEncrypting": "Encrypting {cookies} cookies\u2026",
    "statusDownloading": "Downloading shared cookies\u2026",
    "statusImportingReceived": "Received {cookies} cookies from {sites} site(s). Importing everything\u2026",
    "statusPreparingShare": "Preparing share\u2026",
    "statusReadingCode": "Reading share code\u2026",
    "statusFetchingAccount": "Fetching share from your account\u2026",
    "statusReady": "Ready.",
    "importCookieInvalid": "Invalid cookie payload received.",
    "importCookieRefused": "Browser refused the cookie.",
    "statusCollectingData": "Collecting site data, history and app storage\u2026",
    "statusCollectingIDB": "Collecting app storage \u2014 this can take a minute on sites like WhatsApp\u2026",
    "buttonBusyCollecting": "Collecting\u2026",
    "shareCollectTimeout": "Collecting site data took too long. Close heavy tabs and try sharing again.",
    "statusImportingHistory": "Importing {count} history entries\u2026",
    "importDoneFull": "Done! Imported {restored} of {total} cookie(s) from {sites} site(s){historySummary}, site data staged for {origins} site(s){idbSummary}.{whatsappNote}{whatsappIDBNote} You're logged in.{failedNote}",
    "shareDiagnosticsSuffix": " Diagnostics \u2014 {history} history entries, {origins} site(s) with {keys} keys, IndexedDB: {idb}. WhatsApp: {whatsapp}.",
    "idbSummaryNone": "no databases",
    "idbSummarySome": "{count} DBs",
    "idbSkippedNote": " ({skipped} skipped: {names})",
    "importIDBSummary": ", IndexedDB staged for {count} origin(s){skippedNote}",
    "importIDBSkippedNote": " ({skipped} skipped)",
    "whatsappCaptured": "captured ({keys} keys{extra})",
    "whatsappCapturedExtra": ", IndexedDB: {dbs}",
    "whatsappNotCaptured": "not captured (open web.whatsapp.com on Device A, then share again)",
    "importHistorySummary": ", {done}/{total} history entries{failedNote}",
    "importHistoryFailedNote": " ({failed} failed)",
    "whatsappStagedNote": " WhatsApp data staged for restore.",
    "whatsappNotStagedNote": " WhatsApp data was not staged.",
    "whatsappIDBStagedNote": " WhatsApp app storage staged.",
    "whatsappIDBNotStagedNote": " WhatsApp app storage was not staged.",
    "restoreStatusNone": "No restores recorded yet on this device \u2014 visit a transferred site first.",
    "restoreStatusHeader": "Restore status \u2014 {count} origin(s):",
    "restoreStatusLine": "{origin}: {keys} localStorage keys, {dbs} IndexedDB DBs{failed}",
    "restoreStatusFailed": " ({failed} failed: {names})",
    "restoreStatusPending": " Still pending: {pending}.",
    "diagnoseResult": "Open tabs with data: {origins} site(s), {keys} keys total. WhatsApp \u2014 localStorage: {waKeys} keys, IndexedDB: {waDbCount} DBs ({waStores} stores).",
    "diagnoseNoTabs": "No http(s) tabs open \u2014 open your sites (including web.whatsapp.com) and try again."
  },
  "account": {
    "id": "c196e63a5a7b5ce11891e9b299e1725b"
  }
};

export type ExtRole = "child" | "admin";

export const EXT_MESSAGE_KEYS: string[] = Object.keys(
  EXT_DEFAULT_CONFIG.messages as Record<string, string>
);
