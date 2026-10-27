// =========================================================================
// RELAYN — license registry (in-memory, TypeScript)
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
// NOTE: in-memory, exactly like shares, backups and presence on
// this server. A restart or redeploy wipes the registry back to
// the seeded state below. That limit is stated plainly in the
// console's Overview tab.
// =========================================================================

export type LicenseProduct = "ext" | "mover" | "admin";
export type LicenseStatus = "active" | "revoked";

export interface License {
  product: LicenseProduct;
  accountId: string;
  label: string;
  status: LicenseStatus;
  issuedAt: string; // RFC3339 / ISO
  note: string;
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

  constructor() {
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
  issue(
    product: LicenseProduct,
    accountId: string,
    label = "",
    note = ""
  ): License {
    const existing = this.get(product, accountId);
    const lic: License = {
      product,
      accountId,
      label: label !== "" ? label : (existing?.label ?? ""),
      status: "active",
      issuedAt: new Date().toISOString(),
      note: note !== "" ? note : (existing?.note ?? "")
    };
    this.licenses.set(this.key(product, accountId), lic);
    return lic;
  }

  /** Mark a license revoked. Undefined when there is no such license. */
  revoke(
    product: LicenseProduct,
    accountId: string
  ): License | undefined {
    const lic = this.get(product, accountId);
    if (!lic) return undefined;
    lic.status = "revoked";
    return lic;
  }

  /** Mark a license active again. Undefined when there is no such license. */
  restore(
    product: LicenseProduct,
    accountId: string
  ): License | undefined {
    const lic = this.get(product, accountId);
    if (!lic) return undefined;
    lic.status = "active";
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
}
