import { expect } from "vitest";
import { RagTenancy } from "../../rag/types.js";
import {
  DOCS,
  liveSignal,
  NEAR_IDENTICAL_TENANTS,
  TENANT_A,
  TENANT_B,
  textsOf,
  WIDE,
  type RagContractCase,
} from "./rag-connector-data.js";

/**
 * The cases of a shared connector (#818, `tenancy: RagTenancy.Shared`) in place of the isolation
 * cases: one corpus every tenant reads alike, replaced for all by a re-index, served to a tenant it
 * never saw.
 */

const SHARED = [RagTenancy.Shared] as const;

/** A retrieval's results as comparable keys, in order. */
const keysOf = (results: readonly { readonly source: string; readonly text: string }[]) =>
  results.map((result) => `${result.source}\u0000${result.text}`);

/** Tenants a shared corpus serves alike: two plain ones and the near-identical ids. */
const EVERY_TENANT: readonly string[] = [TENANT_A, TENANT_B, ...NEAR_IDENTICAL_TENANTS];

const sharedCorpus: RagContractCase = {
  tenancies: SHARED,
  name: "#818 shared: one corpus — every tenant, near-identical ids included, gets the same results for the same query",
  run: async ({ fill, retrieve }) => {
    await fill(TENANT_A, [
      { source: "hours.md", text: "The help desk opens at nine every morning." },
      { source: "returns.md", text: "Returns are accepted for thirty days." },
    ]);
    const ask = (tenantId: string) =>
      retrieve("When does the help desk open?", { topK: WIDE, tenantId, signal: liveSignal() });

    const asA = keysOf((await ask(TENANT_A)).results);
    expect(asA.length, "the corpus answers").toBeGreaterThan(0);
    for (const tenantId of EVERY_TENANT) {
      const index = EVERY_TENANT.indexOf(tenantId);
      expect({ tenant: index, results: keysOf((await ask(tenantId)).results) }).toEqual({
        tenant: index,
        results: asA,
      });
    }
  },
};

const sharedReindex: RagContractCase = {
  tenancies: SHARED,
  name: "#818 shared: re-index replaces the corpus — the same documents twice leave one set; a changed document's old text and a removed one are gone for every tenant that read them before",
  run: async ({ fill, retrieve }) => {
    const ask = (tenantId: string) =>
      retrieve("leave", { topK: WIDE, tenantId, signal: liveSignal() });
    const readers = [TENANT_A, TENANT_B, ...NEAR_IDENTICAL_TENANTS.slice(0, 2)];
    await fill(TENANT_A, DOCS);
    const once = (await ask(TENANT_A)).results;
    await fill(TENANT_A, DOCS);
    const twice = keysOf((await ask(TENANT_A)).results);

    expect(once.length, "the corpus answers").toBeGreaterThan(0);
    expect(new Set(twice).size, "a chunk returned twice").toBe(twice.length);
    expect(twice.length).toBe(once.length);
    // every reader has read the corpus before it changes: a copy kept per tenant is caught
    for (const tenantId of readers)
      expect((await ask(tenantId)).results.length, tenantId).toBeGreaterThan(0);
    await fill(TENANT_A, [{ source: "leave.md", text: "Leave is thirty days a year now." }]);
    for (const tenantId of readers)
      expect(textsOf((await ask(tenantId)).results), tenantId).toEqual([
        "Leave is thirty days a year now.",
      ]);
  },
};

const everyTenantServed: RagContractCase = {
  tenancies: SHARED,
  name: "#818 shared: a tenant it never saw — a 200-character id, `/` in it — is served the corpus, and the calls it gets carry that tenant (through the core's reranking too)",
  run: async ({ calls, fill, retrieve }) => {
    await fill(TENANT_A, DOCS);

    for (const tenantId of [TENANT_B, "tenant/a", "k".repeat(200)]) {
      const from = calls.length;
      const { results } = await retrieve("leave", { topK: 2, tenantId, signal: liveSignal() });
      const seen = calls.slice(from);

      expect(results.length, `${tenantId}: the corpus answers`).toBeGreaterThan(0);
      expect(seen.map((one) => one.call)).toContain("retrieve");
      expect(
        seen.filter((one) => one.tenantId !== tenantId),
        `${tenantId}: another tenant passed`,
      ).toEqual([]);
    }
  },
};

/** The shared cases, in the order the suite registers them. */
export const SHARED_CASES: readonly RagContractCase[] = [
  sharedCorpus,
  sharedReindex,
  everyTenantServed,
];
