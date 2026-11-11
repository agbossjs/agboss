/**
 * #890 AC1 (API review G8, A-runtime 10.1): `@agboss/core/stores` is what a store outside the core is
 * written with — the contracts, their records, the rows at a store's boundary and the core's store
 * helpers — and the root entry, an application's autocomplete, keeps the contracts and records but
 * no store helper and no boundary row. Its API report is `api/agboss-stores.api.md`; that every
 * type a contract names is importable from the root or this entry is
 * `tests/public-api/contract-types.test.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "../../src/index.js";
import * as stores from "../../src/stores/index.js";

/** The store helpers and rows that left the root entry for `/stores` (values; rows are types). */
const STORE_HELPERS = [
  "assertEffectName",
  "assertBusinessKey",
  "replayedFromOf",
  "storedKeyFactsOf",
  "effectKeyIdentityOf",
  "pendingOutboundCallOf",
  "fingerprintErrorOf",
  "isKeyFingerprint",
  "remainingOf",
  "idGeneratorNameOf",
  "assertLedgerCutoff",
  "assertLedgerEntries",
  "expiredEntriesOf",
  "unrecordedEntriesOf",
  "InMemoryFencedEffectTransaction",
  "OutboundCallLeaseState",
] as const;

/** The store-boundary rows of an outbound-call store, gone from the root's API report. */
const ROWS = [
  "OutboundCallIntent",
  "OutboundCallClaim",
  "OutboundCallState",
  "OutboundCallLease",
  "OutboundCallStep",
  "OutboundCallStatusQuery",
] as const;

const report = (name: string): string =>
  readFileSync(new URL(`../../api/${name}.api.md`, import.meta.url), "utf8");

/** The names a report exports (`export class X`, `export function X`, `export type X`, …). */
const exportedIn = (text: string): Set<string> =>
  new Set(
    [
      ...text.matchAll(
        /^export (?:declare )?(?:abstract )?(?:class|function|interface|type|enum|const) (\w+)/gmu,
      ),
    ].map((match) => match[1] ?? ""),
  );

describe("#890 AC1: @agboss/core/stores", () => {
  it("AC1: exports the store helpers; the root entry exports none of them", () => {
    for (const name of STORE_HELPERS) {
      expect(stores, name).toHaveProperty(name);
      expect(root, name).not.toHaveProperty(name);
    }
  });

  it("AC1: re-exports the contracts the root keeps, the same classes", () => {
    expect(stores.FencedEffectRepository).toBe(root.FencedEffectRepository);
    expect(stores.OutboundCallRepository).toBe(root.OutboundCallRepository);
    expect(stores.ExecutionRecordRepository).toBe(root.ExecutionRecordRepository);
    expect(stores.PausedExecutionRepository).toBe(root.PausedExecutionRepository);
  });

  it("AC1: is a published entry with its own API report; the root's report exports no helper or row", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { readonly exports: Readonly<Record<string, unknown>> };
    const storesReport = exportedIn(report("agboss-stores"));
    const rootReport = exportedIn(report("agboss"));

    expect(pkg.exports["./stores"]).toEqual({
      types: "./dist/stores/index.d.ts",
      import: "./dist/stores/index.js",
    });
    for (const name of [...STORE_HELPERS, ...ROWS]) {
      expect(storesReport.has(name), name).toBe(true);
      expect(rootReport.has(name), name).toBe(false);
    }
  });
});
