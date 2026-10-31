// =========================================================================
// RELAYN — license registry (disk-backed, TypeScript)
// -------------------------------------------------------------------------
// One license per (product, account). Products are the three Relayn
// surfaces this server knows about: "ext" (the browser extension),
// "mover" (the Mover side of a pair) and "admin" (the Admin side,
// which also covers the host and viewer builds: they are admin-side
// downloads, see productForRole in mover-console.ts).
//
// A license is either "active" or "revoked". Revoking is a soft
// block, not a deletion: it stops NEW enrollments and NEW build
// downloads for that account and product (the gates live in
// mover-headless.ts and mover-console.ts). It does not end machines
// or sessions that are already running, and restore() undoes it.
//
// DURABLE: constructed with a state doc (index.ts passes the
// shared StateDocs and the key state/licenses.json), the registry
// is written
// through on every change and reloaded at boot, so revocations
// survive restarts and redeploys. The seeds below are the floor:
// records in the state file override them, and any seed missing
// from the file is backfilled. Without a state file the store is
// memory-only (the shape unit-style callers used before).
// =========================================================================

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { StateDocs } from "./storage.js";

export type LicenseProduct = "ext" | "mover" | "admin";
export type LicenseStatus = "active" | "revoked";

export interface License {
  product: LicenseProduct;
  accountId: string;
  label: string;
  status: LicenseStatus;
  issuedAt: string; // RFC3339 / ISO
  note: string;
  /**
   * The account's bound admin key (64 hex chars, from 32 random
   * bytes). Only ever set on the "admin" product record. Builds
   * issued for the account bake this key in, and admin-side
   * routes for the account require it (see admin-key.ts). It
   * lives in the durable licence document on the same trust
   * footing as the machine secrets the mover store holds. It is
   * NEVER returned by any list or read API and never logged:
   * read models go through publicLicense(), which exposes only
   * adminKeyBound.
   */
  adminKey?: string;
}

/** The read shape every API answers with: no key material, ever. */
export interface PublicLicense extends Omit<License, "adminKey"> {
  adminKeyBound: boolean;
}

const ADMIN_KEY_RE = /^[0-9a-f]{64}$/;

/** Strip the raw key from a record for any outward answer. */
export function publicLicense(lic: License): PublicLicense {
  const { adminKey, ...rest } = lic;
  return {
    ...rest,
    adminKeyBound: typeof adminKey === "string" && adminKey !== ""
  };
}

export const LICENSE_PRODUCTS: readonly LicenseProduct[] = [
  "ext",
  "mover",
  "admin"
];

export function isLicenseProduct(input: unknown): input is LicenseProduct {
  return (
    typeof input === "string" &&
    (LICENSE_PRODUCTS as readonly string[]).includes(input)
  );
}

/** Accounts that ship with a full set of active licenses. */
const SEEDED_ACCOUNTS: ReadonlyArray<{ accountId: string; label: string }> = [
  { accountId: "mv79ce74e43cc48d276ca0", label: "Owner" },
  { accountId: "mv67c7c1a8916a988e0000", label: "Assistant test pair" }
];

const SEEDED_NOTE =
  "Pre-seeded license: this account shipped with Relayn and was given a full set of active licenses when the server started.";

export class LicenseStore {
  private licenses = new Map<string, License>();
  private readonly docs?: StateDocs;
  private readonly docKey: string;

  constructor(docs?: StateDocs, docKey = "state/licenses.json") {
    this.docs = docs;
    this.docKey = docKey;
    const issuedAt = new Date().toISOString();
    for (const seed of SEEDED_ACCOUNTS) {
      for (const product of LICENSE_PRODUCTS) {
        this.licenses.set(this.key(product, seed.accountId), {
          product,
          accountId: seed.accountId,
          label: seed.label,
          status: "active",
          issuedAt,
          note: SEEDED_NOTE
        });
      }
    }
  }

  /**
   * Boot load: records in the state doc override the seeds, and
   * any seed missing from the doc is backfilled (the constructor
   * already laid the seeds down, so applying the doc is enough).
   */
  async init(): Promise<void> {
    if (!this.docs) return;
    const issuedAt = new Date().toISOString();
    const saved = await this.docs.loadJSON<License[]>(this.docKey);
    if (Array.isArray(saved)) {
      let dropped = 0;
      for (const lic of saved) {
        if (
          lic &&
          typeof lic === "object" &&
          isLicenseProduct(lic.product) &&
          typeof lic.accountId === "string" &&
          lic.accountId !== "" &&
          (lic.status === "active" || lic.status === "revoked")
        ) {
          this.licenses.set(this.key(lic.product, lic.accountId), {
            product: lic.product,
            accountId: lic.accountId,
            label: typeof lic.label === "string" ? lic.label : "",
            status: lic.status,
            issuedAt: typeof lic.issuedAt === "string" ? lic.issuedAt : issuedAt,
            note: typeof lic.note === "string" ? lic.note : "",
            ...(typeof lic.adminKey === "string" && ADMIN_KEY_RE.test(lic.adminKey)
              ? { adminKey: lic.adminKey }
              : {})
          });
        } else {
          dropped++;
        }
      }
      if (dropped > 0) {
        console.error(
          `[relayn] licenses state doc ${this.docKey}: dropped ${dropped} malformed record(s) at load.`
        );
      }
    }
  }

  /** Write the whole registry through to the state doc, if any. */
  private async persist(): Promise<void> {
    if (!this.docs) return;
    await this.docs.saveJSON(this.docKey, [...this.licenses.values()]);
  }

  private key(product: LicenseProduct, accountId: string): string {
    return `${product}:${accountId}`;
  }

  /** Every license, or only one product's. Insertion order. */
  list(product?: LicenseProduct): License[] {
    const all = [...this.licenses.values()];
    return product ? all.filter((lic) => lic.product === product) : all;
  }

  get(
    product: LicenseProduct,
    accountId: string
  ): License | undefined {
    return this.licenses.get(this.key(product, accountId));
  }

  /**
   * Issue (or re-issue) a license: upserts the record to active.
   * Re-issuing a revoked license restores it; the label and note
   * are replaced when the caller passes new ones, and issuedAt is
   * refreshed so the console shows when it last became active.
   */
  async issue(
    product: LicenseProduct,
    accountId: string,
    label = "",
    note = ""
  ): Promise<License> {
    const existing = this.get(product, accountId);
    const lic: License = {
      product,
      accountId,
      label: label !== "" ? label : (existing?.label ?? ""),
      status: "active",
      issuedAt: new Date().toISOString(),
      note: note !== "" ? note : (existing?.note ?? ""),
      // Re-issuing a license must never silently unbind the
      // account: the bound admin key rides through untouched.
      ...(existing?.adminKey ? { adminKey: existing.adminKey } : {})
    };
    this.licenses.set(this.key(product, accountId), lic);
    await this.persist();
    return lic;
  }

  /** Mark a license revoked. Undefined when there is no such license. */
  async revoke(
    product: LicenseProduct,
    accountId: string
  ): Promise<License | undefined> {
    const lic = this.get(product, accountId);
    if (!lic) return undefined;
    lic.status = "revoked";
    await this.persist();
    return lic;
  }

  /** Mark a license active again. Undefined when there is no such license. */
  async restore(
    product: LicenseProduct,
    accountId: string
  ): Promise<License | undefined> {
    const lic = this.get(product, accountId);
    if (!lic) return undefined;
    lic.status = "active";
    await this.persist();
    return lic;
  }

  isRevoked(product: LicenseProduct, accountId: string): boolean {
    return this.get(product, accountId)?.status === "revoked";
  }

  /** True when ANY product license for this account is revoked. */
  hasRevoked(accountId: string): boolean {
    for (const lic of this.licenses.values()) {
      if (lic.accountId === accountId && lic.status === "revoked") {
        return true;
      }
    }
    return false;
  }

  /** The union of account IDs that hold at least one license. */
  accounts(): string[] {
    const out = new Set<string>();
    for (const lic of this.licenses.values()) out.add(lic.accountId);
    return [...out];
  }

  // ---------------------------------------------------------------
  // The bound admin key. The key lives on the account's "admin"
  // product record: one key bounds every admin-side build and
  // caller for the account (Admin, Host, Admin Viewer, EXT pair
  // config) to that account's own estate, so one licence's admin
  // surface can never reach another licence's machines.
  // ---------------------------------------------------------------

  /** True when the account's admin license carries a bound key. */
  adminKeyBound(accountId: string): boolean {
    const key = this.get("admin", accountId)?.adminKey;
    return typeof key === "string" && key !== "";
  }

  /**
   * The raw bound key, for build baking only (the package and
   * config issuers inside this server). Never returned by any
   * route, never logged. "" when the account is not bound.
   */
  boundAdminKey(accountId: string): string {
    const key = this.get("admin", accountId)?.adminKey;
    return typeof key === "string" ? key : "";
  }

  /**
   * Bind a fresh admin key to the account, or rotate the bound
   * one: a new key is generated from crypto randomness and
   * replaces any old one in the same write, so the old key stops
   * working the moment this returns. Returns false when the
   * account holds no admin license to bind to.
   */
  async setAdminKey(accountId: string): Promise<boolean> {
    const lic = this.get("admin", accountId);
    if (!lic) return false;
    lic.adminKey = randomBytes(32).toString("hex");
    await this.persist();
    return true;
  }

  /**
   * Check a presented admin key for an account. "open" means the
   * account is not bound, so no key is required (the standing
   * account-id-only model). The comparison runs over SHA-256
   * digests of both sides, so it is constant-time whatever
   * length the presented value has.
   */
  verifyAdminKey(
    accountId: string,
    presented: string
  ): "open" | "ok" | "missing" | "mismatch" {
    const held = this.get("admin", accountId)?.adminKey;
    if (typeof held !== "string" || held === "") return "open";
    if (typeof presented !== "string" || presented === "") {
      return "missing";
    }
    const given = createHash("sha256").update(presented, "utf8").digest();
    const kept = createHash("sha256").update(held, "utf8").digest();
    return timingSafeEqual(given, kept) ? "ok" : "mismatch";
  }
}
