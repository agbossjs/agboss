import { expect } from "vitest";
import { RagTenancy } from "../../rag/types.js";
import { SHARED_CASES } from "./rag-connector-shared.cases.js";
import {
  DOCS,
  isLedgerCost,
  liveSignal,
  markerOf,
  NEAR_IDENTICAL_TENANTS,
  TENANT_A,
  TENANT_B,
  textsOf,
  WIDE,
  type RagContractCase,
} from "./rag-connector-data.js";

/**
 * The rules of the RAG connector contract (#700), each a case of `ragConnectorContract` — for a
 * connector of each tenant's own passages, of one shared corpus (#818), or both.
 */

const PER_TENANT = [RagTenancy.PerTenant] as const;
const EITHER = [RagTenancy.PerTenant, RagTenancy.Shared] as const;

const isolation: RagContractCase = {
  tenancies: PER_TENANT,
  name: "#700 AC1: cross-tenant isolation — a passage only tenant B has is never returned to tenant A, for a query made of its own words; B finds it",
  run: async ({ fill, retrieve }) => {
    await fill(TENANT_A, [{ source: "hours.md", text: "The office opens at nine every morning." }]);
    await fill(TENANT_B, [{ source: "vault.md", text: "The vault code is plum seventeen." }]);
    const query = "What is the vault code?";
    const signal = liveSignal();

    const asA = await retrieve(query, { topK: WIDE, tenantId: TENANT_A, signal });
    const asB = await retrieve(query, { topK: WIDE, tenantId: TENANT_B, signal });

    const leaked = asA.results.filter((r) => r.source === "vault.md" || r.text.includes("plum"));
    expect(leaked, "tenant A was given tenant B's passage").toEqual([]);
    expect(
      textsOf(asB.results).some((text) => text.includes("plum")),
      "B finds its own",
    ).toBe(true);
  },
};

const nearIdentical: RagContractCase = {
  tenancies: PER_TENANT,
  name: "#700: near-identical tenant ids — case, width, NFC and accent twins, `/` and `%2F`, 200 characters — are each their own tenant: each gets its own passage only",
  run: async ({ fill, retrieve }) => {
    for (const [index, tenantId] of NEAR_IDENTICAL_TENANTS.entries()) {
      const text = `Isolation probe passage ${markerOf(index)}.`;
      await fill(tenantId, [{ source: `probe-${String(index)}.md`, text }]);
    }
    for (const [index, tenantId] of NEAR_IDENTICAL_TENANTS.entries()) {
      const { results } = await retrieve("isolation probe passage", {
        topK: WIDE,
        tenantId,
        signal: liveSignal(),
      });
      const markers = NEAR_IDENTICAL_TENANTS.map((_, other) => markerOf(other)).filter((marker) =>
        textsOf(results).some((text) => text.includes(marker)),
      );
      expect({ tenant: index, markers }).toEqual({ tenant: index, markers: [markerOf(index)] });
    }
  },
};

const reindex: RagContractCase = {
  tenancies: PER_TENANT,
  name: "#700 AC3: re-index replaces — the same documents twice leave one set of chunks; a changed document's old text and a removed document are gone; another tenant's chunks stay",
  run: async ({ fill, retrieve }) => {
    const ask = (tenantId: string) =>
      retrieve("leave", { topK: WIDE, tenantId, signal: liveSignal() });
    await fill(TENANT_B, [{ source: "leave.md", text: "Leave of tenant B is thirty days." }]);
    await fill(TENANT_A, DOCS);
    const once = (await ask(TENANT_A)).results;
    await fill(TENANT_A, DOCS);
    const twice = (await ask(TENANT_A)).results;

    const keys = twice.map((r) => `${r.source}\u0000${r.text}`);
    expect(new Set(keys).size, "a chunk returned twice").toBe(keys.length);
    expect(twice.length).toBe(once.length);
    await fill(TENANT_A, [{ source: "leave.md", text: "Leave is thirty days a year now." }]);
    const changed = (await ask(TENANT_A)).results;
    expect(textsOf(changed).some((text) => text.includes("twenty five"))).toBe(false);
    expect(changed.some((r) => r.source === "oncall.md")).toBe(false);
    expect(textsOf((await ask(TENANT_B)).results)).toEqual(["Leave of tenant B is thirty days."]);
  },
};

const topK: RagContractCase = {
  tenancies: EITHER,
  name: "#700: topK — with more matches than topK, at least one and at most topK results",
  run: async ({ fill, retrieve }) => {
    const documents = Array.from({ length: 8 }, (_, index) => ({
      source: `match-${String(index)}.md`,
      text: `Probe match number ${markerOf(index)} for the topK case.`,
    }));
    await fill(TENANT_A, documents);
    for (const k of [1, 3]) {
      const { results } = await retrieve("probe match", {
        topK: k,
        tenantId: TENANT_A,
        signal: liveSignal(),
      });
      const isWithin = results.length >= 1 && results.length <= k;
      expect({ topK: k, count: results.length, isWithin }).toMatchObject({ isWithin: true });
    }
  },
};

const aborted: RagContractCase = {
  tenancies: EITHER,
  name: "#700: an aborted signal rejects retrieve and index",
  run: async ({ connector, fill, retrieve }) => {
    await fill(TENANT_A, DOCS);
    const controller = new AbortController();
    controller.abort(new Error("aborted by the suite"));
    const { signal } = controller;

    // a throw before the promise counts as a refusal too
    const later = <T>(call: () => Promise<T>): Promise<T> => Promise.resolve().then(call);
    await expect(
      later(() => retrieve("leave", { topK: 2, tenantId: TENANT_A, signal })),
    ).rejects.toThrow();
    const { index } = connector;
    if (index !== undefined)
      await expect(
        later(() => index.call(connector, { tenantId: TENANT_A, signal })),
      ).rejects.toThrow();
  },
};

const cost: RagContractCase = {
  tenancies: EITHER,
  name: "#700: cost — a retrieval's and an index's costUsd is absent or a finite number from 0",
  run: async ({ connector, fill, retrieve }) => {
    await fill(TENANT_A, DOCS);
    const retrieval = await retrieve("leave", {
      topK: 2,
      tenantId: TENANT_A,
      signal: liveSignal(),
    });
    const report = await connector.index?.({ tenantId: TENANT_A, signal: liveSignal() });

    expect({ retrieval: isLedgerCost(retrieval.costUsd) }).toEqual({ retrieval: true });
    expect({ index: isLedgerCost(report?.costUsd) }).toEqual({ index: true });
  },
};

const shape: RagContractCase = {
  tenancies: EITHER,
  name: "#700: every result has a non-empty text and source; a score is finite",
  run: async ({ fill, retrieve }) => {
    await fill(TENANT_A, DOCS);
    const { results } = await retrieve("leave", {
      topK: 5,
      tenantId: TENANT_A,
      signal: liveSignal(),
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.text.length > 0 && result.source.length > 0).toBe(true);
      expect(result.score === undefined || Number.isFinite(result.score)).toBe(true);
    }
  },
};

/** Every case, in the order the suite registers them. */
export const RAG_CONNECTOR_CASES: readonly RagContractCase[] = [
  isolation,
  nearIdentical,
  reindex,
  topK,
  aborted,
  cost,
  shape,
  ...SHARED_CASES,
];
