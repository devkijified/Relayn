// =========================================================================
// RELAYN: object storage backends (TypeScript)
// -------------------------------------------------------------------------
// Every byte the server persists rides one ObjectStorage, addressed
// by slash keys that mirror the layout the disk store always used:
//
//   state/<name>.json                  small durable state documents
//   <account>/<moveId>/meta.json       move metadata          (BULK)
//   <account>/<moveId>/manifest.json   the pack manifest      (BULK)
//   <account>/<moveId>/chunks/<n>      one sealed chunk       (BULK)
//   <account>/_partition/<machineId>/ledger.json   Partition ledger
//
// Two backends sit under the same interface:
//
//   LOCAL (the default, today's behaviour): keys are files under
//   MOVER_DATA_DIR, written atomically (temp sibling + rename).
//
//   R2 (selected by env, below): keys are objects in a private
//   Cloudflare R2 bucket, spoken to over its S3-compatible HTTPS
//   API with AWS SigV4 signing done by hand (node:crypto only, no
//   new dependencies). The bucket is private: nothing is publicly
//   served; only this server, holding the API token's credentials,
//   can read or write.
//
// Env contract (values are set on the host, e.g. Render; NO secret
// value ever appears in code, tests or logs):
//   R2_ACCOUNT_ID         Cloudflare account id
//   R2_BUCKET             bucket name
//   R2_ACCESS_KEY_ID      R2 API token access key id
//   R2_SECRET_ACCESS_KEY  R2 API token secret access key
//   R2_ENDPOINT           optional override of the derived endpoint
//                         https://<account>.r2.cloudflarestorage.com
//                         (tests point it at an in-process stub)
// R2 is active only when the four required values are ALL present.
// A partial set is a loud boot error in the log and the server
// falls back to LOCAL rather than crashing: a store that will not
// boot helps nobody.
//
// STATE vs BULK: state documents (state/** and the Partition
// ledgers) NEVER expire. Bulk (the move trees) expires after the
// bulk window measured from LAST USE (see MoverStore's sweep):
// reads and writes refresh a move's entry in the durable
// state/bulk-use.json index, and the sweep deletes only move
// trees idle past the window.
//
// StateDocs keeps the contract the durable store was built on
// (see git history, state-file.ts): a mutation is durable before
// the call that caused it returns (single-object writes are
// atomic on both backends), loads tolerate a missing document
// (first boot: empty, quietly) and a corrupt one (empty start,
// loud log, the corrupt bytes preserved at "<key>.corrupt-<ts>").
// =========================================================================

import { createHash, createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

export interface StoredObjectMeta {
  size: number;
  lastModifiedMs: number;
}

export interface ObjectStorage {
  readonly kind: "local" | "r2";
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
  del(key: string): Promise<void>;
  /** Every key under the prefix ("" = the whole store), sorted. */
  list(prefix: string): Promise<string[]>;
  stat(key: string): Promise<StoredObjectMeta | undefined>;
}

/** True when a key holds expiring bulk rather than eternal state. */
export function isBulkKey(key: string): boolean {
  if (key.startsWith("state/")) return false;
  if (key.includes("/_partition/")) return false;
  return true;
}

/** The bulk unit a key belongs to: "<account>/<moveId>", or null. */
export function bulkUnitOf(key: string): string | null {
  if (!isBulkKey(key)) return null;
  const parts = key.split("/");
  if (parts.length < 3 || parts[0] === "" || parts[1] === "") return null;
  return `${parts[0]}/${parts[1]}`;
}

// -----------------------------------------------------------------
// LOCAL backend: files under a root directory.
// -----------------------------------------------------------------

let tmpCounter = 0;

export class LocalObjectStorage implements ObjectStorage {
  readonly kind = "local" as const;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
    mkdirSync(this.root, { recursive: true });
  }

  private fileFor(key: string): string {
    const file = path.resolve(this.root, ...key.split("/"));
    if (file !== this.root && !file.startsWith(this.root + path.sep)) {
      throw new Error(`storage key escapes the data dir: ${key}`);
    }
    return file;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.fileFor(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    tmpCounter += 1;
    const tmp = `${file}.tmp-${process.pid}-${tmpCounter}`;
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, file);
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      return await fsp.readFile(this.fileFor(key));
    } catch {
      return undefined;
    }
  }

  async del(key: string): Promise<void> {
    await fsp.rm(this.fileFor(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), childRel);
        } else if (entry.isFile()) {
          // Skip in-flight atomic-write siblings: they are not
          // objects, they are write mechanics.
          if (entry.name.includes(".tmp-")) continue;
          out.push(childRel);
        }
      }
    };
    await walk(this.root, "");
    return out.filter((k) => k.startsWith(prefix)).sort();
  }

  async stat(key: string): Promise<StoredObjectMeta | undefined> {
    try {
      const info = await fsp.stat(this.fileFor(key));
      return { size: info.size, lastModifiedMs: info.mtimeMs };
    } catch {
      return undefined;
    }
  }
}

// -----------------------------------------------------------------
// R2 backend: S3-compatible HTTPS, hand-signed with AWS SigV4.
// -----------------------------------------------------------------

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Base endpoint, no trailing slash. */
  endpoint: string;
}

const S3_REGION = "auto";
const S3_SERVICE = "s3";

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 segment encoding (encodeURIComponent plus !'()* ). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeSegment).join("/");
}

function xmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export class R2ObjectStorage implements ObjectStorage {
  readonly kind = "r2" as const;
  private readonly cfg: R2Config;
  private readonly host: string;

  constructor(cfg: R2Config) {
    this.cfg = cfg;
    this.host = new URL(cfg.endpoint).host;
  }

  /**
   * One signed S3 request. Callers map 404; any other non-2xx
   * throws with the status and a body snippet: a storage failure
   * must be loud, never a silent empty read.
   */
  private async request(
    method: string,
    key: string | null,
    query: Record<string, string>,
    body?: Buffer
  ): Promise<Response> {
    const payload = body ?? Buffer.alloc(0);
    const payloadHash = sha256Hex(payload);
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const dateStamp = amzDate.slice(0, 8);

    const canonicalUri =
      "/" +
      encodeSegment(this.cfg.bucket) +
      (key ? "/" + encodeKey(key) : "");
    const queryKeys = Object.keys(query).sort();
    const canonicalQuery = queryKeys
      .map((k) => `${encodeSegment(k)}=${encodeSegment(query[k])}`)
      .join("&");
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalHeaders =
      `host:${this.host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const scope = `${dateStamp}/${S3_REGION}/${S3_SERVICE}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const kDate = hmac(`AWS4${this.cfg.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, S3_REGION);
    const kService = hmac(kRegion, S3_SERVICE);
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning)
      .update(stringToSign, "utf8")
      .digest("hex");

    const url =
      this.cfg.endpoint +
      canonicalUri +
      (canonicalQuery ? `?${canonicalQuery}` : "");
    return fetch(url, {
      method,
      headers: {
        authorization:
          `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        ...(body ? { "content-length": String(payload.length) } : {})
      },
      body: body ? new Uint8Array(payload) : undefined
    });
  }

  private async failWhat(res: Response, what: string): Promise<Error> {
    const text = await res.text().catch(() => "");
    return new Error(
      `R2 ${what} failed with ${res.status}: ${text.slice(0, 300)}`
    );
  }

  async put(key: string, body: Buffer): Promise<void> {
    const res = await this.request("PUT", key, {}, body);
    if (!res.ok) throw await this.failWhat(res, `PUT ${key}`);
  }

  async get(key: string): Promise<Buffer | undefined> {
    const res = await this.request("GET", key, {});
    if (res.status === 404) return undefined;
    if (!res.ok) throw await this.failWhat(res, `GET ${key}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async del(key: string): Promise<void> {
    const res = await this.request("DELETE", key, {});
    if (res.status === 404) return;
    if (!res.ok) throw await this.failWhat(res, `DELETE ${key}`);
  }

  async stat(key: string): Promise<StoredObjectMeta | undefined> {
    const res = await this.request("HEAD", key, {});
    if (res.status === 404) return undefined;
    if (!res.ok) throw await this.failWhat(res, `HEAD ${key}`);
    const modified = res.headers.get("last-modified");
    return {
      size: Number(res.headers.get("content-length") ?? 0),
      lastModifiedMs: modified ? Date.parse(modified) : 0
    };
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    for (;;) {
      const query: Record<string, string> = {
        "list-type": "2",
        prefix
      };
      if (token) query["continuation-token"] = token;
      const res = await this.request("GET", null, query);
      if (!res.ok) throw await this.failWhat(res, `LIST ${prefix}`);
      const xml = await res.text();
      for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
        keys.push(xmlUnescape(match[1]));
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const next = xml.match(
        /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/
      );
      if (!truncated || !next) break;
      token = xmlUnescape(next[1]);
    }
    return keys.sort();
  }
}

// -----------------------------------------------------------------
// Backend selection + the state-document layer.
// -----------------------------------------------------------------

export function createObjectStorage(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env
): ObjectStorage {
  const accountId = env.R2_ACCOUNT_ID?.trim() ?? "";
  const bucket = env.R2_BUCKET?.trim() ?? "";
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim() ?? "";
  const present = [accountId, bucket, accessKeyId, secretAccessKey].filter(
    (v) => v !== ""
  ).length;
  if (present === 4) {
    const endpoint = (
      env.R2_ENDPOINT?.trim() ||
      `https://${accountId}.r2.cloudflarestorage.com`
    ).replace(/\/+$/, "");
    console.log(
      `[relayn] storage backend: R2 (bucket ${bucket}, endpoint ${endpoint})`
    );
    return new R2ObjectStorage({
      accountId,
      bucket,
      accessKeyId,
      secretAccessKey,
      endpoint
    });
  }
  if (present > 0) {
    console.error(
      `[relayn] STORAGE CONFIG INCOMPLETE: ${present} of the 4 R2 env ` +
        `values are set (R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, ` +
        `R2_SECRET_ACCESS_KEY). Falling back to the LOCAL backend ` +
        `under ${dataDir}; set all four (or none) to change this.`
    );
  } else {
    console.log(`[relayn] storage backend: local (${dataDir})`);
  }
  return new LocalObjectStorage(dataDir);
}

/**
 * The durable state documents the stores stand on: one JSON (or
 * pretty text, for the Partition ledger) document per key, written
 * through on every mutation. Single-object writes are atomic on
 * both backends, so a mutation is durable before its call returns
 * and a crash can never resurrect consumed state. Loads mirror
 * the old state-file contract: missing = undefined (quiet first
 * boot); corrupt = loud log, the bytes preserved aside at
 * "<key>.corrupt-<ts>", undefined.
 */
export class StateDocs {
  constructor(private readonly storage: ObjectStorage) {}

  async loadText(key: string): Promise<string | undefined> {
    const raw = await this.storage.get(key);
    if (raw === undefined) return undefined;
    return raw.toString("utf8");
  }

  async loadJSON<T>(key: string): Promise<T | undefined> {
    const raw = await this.loadText(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      const aside = `${key}.corrupt-${Date.now()}`;
      console.error(
        `[relayn] STATE DOC CORRUPT: ${key} could not be parsed ` +
          `(${(err as Error).message}). That store starts empty; the ` +
          `corrupt bytes were preserved at ${aside}.`
      );
      try {
        await this.storage.put(aside, Buffer.from(raw, "utf8"));
        await this.storage.del(key);
      } catch {
        // Best effort only: the loud log above is the record.
      }
      return undefined;
    }
  }

  /** Persist a JSON value. Never throws (loud log on failure). */
  async saveJSON(key: string, value: unknown): Promise<void> {
    try {
      await this.storage.put(
        key,
        Buffer.from(JSON.stringify(value), "utf8")
      );
    } catch (err) {
      console.error(
        `[relayn] STATE WRITE FAILED: ${key} could not be persisted ` +
          `(${(err as Error).message}). The change lives in memory ` +
          `only until the next successful write.`
      );
    }
  }

  /** Persist pre-serialized text. Throws on failure (ledger parity). */
  async saveText(key: string, text: string): Promise<void> {
    await this.storage.put(key, Buffer.from(text, "utf8"));
  }
}
