// =========================================================================
// RELAYN: durable state files (TypeScript)
// -------------------------------------------------------------------------
// The small persistence layer the server stores stand on. One JSON
// document per store, under <MOVER_DATA_DIR>/state/ by convention.
//
// Writes are atomic and synchronous: serialize to a temp sibling,
// then rename over the target. A mutation is therefore durable
// before the call that caused it returns, so a crash or a redeploy
// can never resurrect state a request already consumed (a spent
// single-use share, a revoked license, a delivered command).
// Synchronous writes also mean no shutdown flush is needed: the
// stores are correct even if the process is killed outright.
//
// Loads tolerate a missing file (the normal first boot: the store
// starts empty, quietly) and a corrupt one (the store starts
// empty, the failure is logged loudly, and the corrupt file is
// moved aside for forensics). A failed write is logged loudly and
// never thrown into the request path: the change lives in memory
// until the next successful write.
// =========================================================================

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

let tmpCounter = 0;

function tmpSibling(file: string): string {
  tmpCounter += 1;
  return `${file}.tmp-${process.pid}-${tmpCounter}`;
}

/**
 * Read and parse a state file. Undefined when the file is missing
 * (first boot) or corrupt (logged loudly, moved aside).
 */
export function loadStateFile<T>(file: string): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const aside = `${file}.corrupt-${Date.now()}`;
    console.error(
      `[relayn] STATE FILE CORRUPT: ${file} could not be parsed ` +
        `(${(err as Error).message}). That store starts empty; the ` +
        `corrupt file was moved to ${aside}.`
    );
    try {
      renameSync(file, aside);
    } catch {
      // Best effort only: the loud log above is the record.
    }
    return undefined;
  }
}

/** Atomically persist a JSON-serializable value. Never throws. */
export function saveStateFile(file: string, value: unknown): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = tmpSibling(file);
    writeFileSync(tmp, JSON.stringify(value), "utf8");
    renameSync(tmp, file);
  } catch (err) {
    console.error(
      `[relayn] STATE WRITE FAILED: ${file} could not be persisted ` +
        `(${(err as Error).message}). The change lives in memory ` +
        `only until the next successful write.`
    );
  }
}

/**
 * Atomically write pre-serialized text (the Partition ledger keeps
 * its pretty-printed shape). Throws on failure: its caller is an
 * async store method that already surfaces write errors.
 */
export async function saveTextFileAtomic(
  file: string,
  text: string
): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpSibling(file);
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, file);
}
