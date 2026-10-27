// Relayn — lazy site-data restore for imported shares.
//
// When Device B imports a share, per-origin localStorage snapshots are staged
// in chrome.storage.local under "relnaynPendingStorage" and per-origin
// IndexedDB snapshots under "relnaynPendingIDB". This script runs at
// document_start on every page; if there is staged data for this origin it
// restores it BEFORE page scripts run, then clears the staged entry and
// records the restore. Without staged data it does nothing.
//
// IndexedDB restore recreates each database at its captured version with the
// captured object-store schema (keyPath, autoIncrement, indexes), then writes
// all captured records. Values were serialized with a binary-safe encoding
// (ArrayBuffers, typed arrays, Blobs, Dates, Maps, Sets…), decoded below.

function __relnaynB64Decode(b64) {
    const s = atob(String(b64));
    const arr = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
    return arr;
}

function __relnaynIdbDecode(v) {
    if (v === null || v === undefined) return v;
    if (typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(__relnaynIdbDecode);
    const t = v.__relnayn_t;
    if (!t) {
        const o = {};
        for (const k of Object.keys(v)) o[k] = __relnaynIdbDecode(v[k]);
        return o;
    }
    switch (t) {
        case "undef":
            return undefined;
        case "ref":
            return null;
        case "bigint":
            try {
                return BigInt(v.d);
            } catch {
                return null;
            }
        case "date":
            return new Date(v.d);
        case "regexp":
            try {
                return new RegExp(v.s, v.f);
            } catch {
                return null;
            }
        case "arr":
            return (v.d || []).map(__relnaynIdbDecode);
        case "map":
            return new Map((v.d || []).map(([a, b]) => [__relnaynIdbDecode(a), __relnaynIdbDecode(b)]));
        case "set":
            return new Set((v.d || []).map(__relnaynIdbDecode));
        case "bin": {
            const bytes = __relnaynB64Decode(v.d);
            const buf = bytes.buffer;
            if (v.k === "ArrayBuffer") return buf;
            if (v.k === "DataView") return new DataView(buf);
            const Ctor =
                {
                    Int8Array,
                    Uint8Array,
                    Uint8ClampedArray,
                    Int16Array,
                    Uint16Array,
                    Int32Array,
                    Uint32Array,
                    Float32Array,
                    Float64Array,
                    BigInt64Array,
                    BigUint64Array,
                }[v.k] || Uint8Array;
            try {
                return new Ctor(buf);
            } catch {
                return new Uint8Array(buf);
            }
        }
        case "blob":
            return new Blob([__relnaynB64Decode(v.d)], { type: v.t || "" });
        case "blob-skipped":
        case "bin-skipped":
            // Oversized value dropped at capture time (media/cache) — the
            // record keeps a null placeholder so keys stay aligned.
            return null;
        case "file":
            try {
                return new File([__relnaynB64Decode(v.d)], v.n || "file", {
                    type: v.t || "",
                    lastModified: v.l || Date.now(),
                });
            } catch {
                return new Blob([__relnaynB64Decode(v.d)], { type: v.t || "" });
            }
        default:
            return v;
    }
}

function __relnaynIdbRequest(fn) {
    return new Promise((resolve, reject) => {
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
}

function __relnaynWithTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
    ]);
}

// Restore one origin's IndexedDB snapshot. Returns { restored, failed } with
// database names. Each DB is recreated at its captured version so the schema
// (stores, keyPath, indexes) matches Device A exactly.
async function __relnaynRestoreIDB(dbs) {
    const out = { restored: 0, failed: [] };
    for (const db of dbs || []) {
        try {
            await __relnaynWithTimeout(
                (async () => {
                    // Always start from a clean slate: delete any existing
                    // database (no-op when absent) so onupgradeneeded below
                    // reliably recreates the captured schema. (Probing the
                    // version first is wrong: opening a missing DB creates an
                    // empty v1, which then matches a captured v1 and skips
                    // schema creation entirely.)
                    try {
                        await new Promise((resolve) => {
                            let req;
                            try {
                                req = indexedDB.deleteDatabase(db.name);
                            } catch (e) {
                                resolve();
                                return;
                            }
                            req.onsuccess = () => resolve();
                            req.onerror = () => resolve();
                            req.onblocked = () => resolve();
                        });
                    } catch (e) {
                        // ignore — open() below will surface real failures
                    }
                    const idb = await new Promise((resolve, reject) => {
                        const req = indexedDB.open(db.name, db.version);
                        req.onupgradeneeded = (ev) => {
                            const dbh = ev.target.result;
                            const tx = ev.target.transaction;
                            for (const st of db.stores || []) {
                                let store;
                                if (dbh.objectStoreNames.contains(st.name)) {
                                    store = tx.objectStore(st.name);
                                } else {
                                    const params = {};
                                    if (st.keyPath !== null && st.keyPath !== undefined) params.keyPath = st.keyPath;
                                    if (st.autoIncrement) params.autoIncrement = true;
                                    store = dbh.createObjectStore(st.name, params);
                                }
                                for (const ix of st.indexes || []) {
                                    if (!store.indexNames.contains(ix.name)) {
                                        store.createIndex(ix.name, ix.keyPath, {
                                            unique: !!ix.unique,
                                            multiEntry: !!ix.multiEntry,
                                        });
                                    }
                                }
                            }
                        };
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => reject(req.error || new Error("open failed"));
                        req.onblocked = () => {
                            // Another tab holds the DB — don't hang forever.
                            setTimeout(() => reject(new Error("blocked by another tab")), 8000);
                        };
                    });
                    try {
                        for (const st of db.stores || []) {
                            const tx = idb.transaction(st.name, "readwrite");
                            const store = tx.objectStore(st.name);
                            store.clear();
                            for (const rec of st.records || []) {
                                const value = __relnaynIdbDecode(rec.v);
                                if (st.keyPath !== null && st.keyPath !== undefined) {
                                    store.put(value);
                                } else {
                                    store.put(value, __relnaynIdbDecode(rec.k));
                                }
                            }
                            await new Promise((res, rej) => {
                                tx.oncomplete = () => res();
                                tx.onerror = () => rej(tx.error || new Error("transaction failed"));
                                tx.onabort = () => rej(tx.error || new Error("transaction aborted"));
                            });
                        }
                    } finally {
                        try {
                            idb.close();
                        } catch (e) {
                            // ignore
                        }
                    }
                })(),
                20000
            );
            out.restored++;
        } catch (e) {
            out.failed.push(db.name);
        }
    }
    return out;
}

// Fire-and-forget activity report to the background worker, which shows it
// in the popup's restore log. This is how Device B proves what actually
// happened on the page — no console needed.
function __relnaynLog(text) {
    try {
        chrome.runtime.sendMessage({ kind: "restoreLog", origin: location.origin, text: String(text) });
    } catch {
        // Worker unreachable — non-fatal.
    }
}

(async () => {
    let origin = "";
    try {
        origin = location.origin;
    } catch {
        return;
    }
    if (!origin || !/^https?:\/\//i.test(origin)) return;

    // 1) localStorage restore (synchronous writes — wins the race).
    try {
        const got = await chrome.storage.local.get("relnaynPendingStorage");
        const pending = got && got.relnaynPendingStorage;
        const data = pending && pending[origin];
        if (data && typeof data === "object") {
            let applied = 0;
            for (const key of Object.keys(data)) {
                try {
                    localStorage.setItem(key, String(data[key]));
                    applied++;
                } catch {
                    // Storage full or blocked — skip this key.
                }
            }
            // Record BEFORE clearing: if the tab closes mid-restore the
            // record survives and the next visit simply re-applies (idempotent).
            try {
                const got2 = await chrome.storage.local.get("relnaynRestoredOrigins");
                const restored = (got2 && got2.relnaynRestoredOrigins) || {};
                restored[origin] = { keys: applied, at: Date.now() };
                await chrome.storage.local.set({ relaynRestoredOrigins: restored });
            } catch {
                // Non-fatal diagnostics.
            }
            const next = { ...pending };
            delete next[origin];
            try {
                await chrome.storage.local.set({ relaynPendingStorage: next });
            } catch {
                // Non-fatal: the data stays staged and will be applied on next visit.
            }
            __relnaynLog("localStorage: " + applied + " keys restored");
        }
    } catch {
        // Never break the page over restore.
    }

    // 2) IndexedDB restore (async — page scripts may race it; a single
    // reload settles any stragglers since the data is then fully in place).
    try {
        const got = await chrome.storage.local.get("relnaynPendingIDB");
        const pending = got && got.relnaynPendingIDB;
        const snap = pending && pending[origin];
        if (snap && typeof snap === "object" && Array.isArray(snap.dbs) && snap.dbs.length) {
            __relnaynLog("IndexedDB restore started (" + snap.dbs.length + " DBs)…");
            const res = await __relnaynRestoreIDB(snap.dbs);
            // Record BEFORE clearing (see above).
            try {
                const got2 = await chrome.storage.local.get("relnaynRestoredOrigins");
                const restored = (got2 && got2.relnaynRestoredOrigins) || {};
                const prev = restored[origin] || {};
                restored[origin] = {
                    ...prev,
                    idbDbs: res.restored,
                    idbFailed: res.failed,
                    at: Date.now(),
                };
                await chrome.storage.local.set({ relaynRestoredOrigins: restored });
            } catch {
                // Non-fatal diagnostics.
            }
            const next = { ...pending };
            delete next[origin];
            try {
                await chrome.storage.local.set({ relaynPendingIDB: next });
            } catch {
                // Non-fatal.
            }
            __relnaynLog(
                "IndexedDB: " + res.restored + " DBs restored" +
                (res.failed.length ? ", FAILED: " + res.failed.join(", ") : "")
            );
        } else {
            // No staged data: distinguish "already restored on a previous
            // visit" from "nothing was ever staged".
            let rec = null;
            try {
                const got3 = await chrome.storage.local.get("relnaynRestoredOrigins");
                rec = got3 && got3.relnaynRestoredOrigins && got3.relnaynRestoredOrigins[origin];
            } catch {
                rec = null;
            }
            if (rec && rec.at) {
                let t = "";
                try {
                    t = new Date(rec.at).toLocaleTimeString("en-GB", { hour12: false });
                } catch {
                    t = "";
                }
                __relnaynLog(
                    "already restored" + (t ? " at " + t : "") +
                    " (" + (rec.idbDbs || 0) + " DBs" +
                    (rec.idbFailed && rec.idbFailed.length ? ", " + rec.idbFailed.length + " failed" : "") +
                    ")"
                );
            } else {
                __relnaynLog("no staged data for this origin");
            }
            if (snap) {
                // Snapshot exists but holds no databases — clear it.
                const next = { ...pending };
                delete next[origin];
                try {
                    await chrome.storage.local.set({ relaynPendingIDB: next });
                } catch {
                    // ignore
                }
            }
        }
    } catch {
        // Never break the page over restore.
    }
})();
