/**
 * #700 AC2 — the RAG connector contract bites: a sound connector passes every case, and each
 * connector broken one way fails exactly the cases of its rule — ignoring the tenant, folding its id,
 * appending on re-index, ignoring topK, ignoring the signal, reporting NaN.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ragConnectorContract } from "../../../src/testing/contracts/index.js";
import { memoryTarget } from "../../fixtures/contracts/rag-connectors.js";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const FIXTURE = "rag-sabotage.contract-fixture.ts";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([FIXTURE]);
}, 120_000);

/** The failing cases of `target`'s suite, by the start of their names. */
const failedOf = (target: string): readonly string[] =>
  run.cases
    .filter((found) => found.suites[0] === `RAG connector contract (${target})`)
    .filter((found) => found.state === "fail")
    .map((found) => found.name.split(" — ")[0] ?? found.name);

const ISOLATION = "#700 AC1: cross-tenant isolation";
const NEAR = "#700: near-identical tenant ids";
const REINDEX = "#700 AC3: re-index replaces";
const TOP_K = "#700: topK";
const ABORT = "#700: an aborted signal rejects retrieve and index";
const COST = "#700: cost";
const WELL_FORMED = "#700: every result has a non-empty text and source; a score is finite";
const SHARED_CORPUS = "#818 shared: one corpus";
const SHARED_REINDEX = "#818 shared: re-index replaces the corpus";
const EVERY_TENANT_SERVED = "#818 shared: a tenant it never saw";
/** The cases whose retrievals find passages: each goes through the reranker. */
const RETRIEVING = [ISOLATION, NEAR, REINDEX, TOP_K, COST, WELL_FORMED];

describe("#700 AC2: a connector that breaks a rule fails the RAG contract suite", () => {
  it("the sound connector passes every case (7)", () => {
    const cases = run.cases.filter((found) => found.suites[0] === "RAG connector contract (sound)");
    expect(cases.map((found) => found.state)).toEqual(Array(7).fill("pass"));
  });

  it("#799 AC2: a sound reranker in place passes every case (7)", () => {
    const cases = run.cases.filter(
      (found) => found.suites[0] === "RAG connector contract (sound, reranked)",
    );
    expect(cases.map((found) => found.state)).toEqual(Array(7).fill("pass"));
  });

  it.each([
    // its re-index of one tenant replaces the other's too
    ["ignores the tenant", [ISOLATION, NEAR, REINDEX]],
    ["folds the tenant id", [NEAR]],
    ["appends on re-index", [REINDEX]],
    ["ignores topK", [TOP_K]],
    ["ignores the signal", [ABORT]],
    ["reports NaN", [COST]],
    ["ignores the tenant, reranked", [ISOLATION, NEAR, REINDEX]],
  ])("a connector that %s fails %j only", (target, expected) => {
    expect(failedOf(target)).toEqual(expected);
  });

  it.each(["shared", "shared, reranked"])(
    "#818 AC5: a %s corpus passes the Shared cases and the cases of either tenancy (7)",
    (target) => {
      const cases = run.cases.filter(
        (found) => found.suites[0] === `RAG connector contract (${target})`,
      );
      expect(cases.map((found) => found.name.split(" — ")[0])).toEqual([
        TOP_K,
        ABORT,
        COST,
        WELL_FORMED,
        SHARED_CORPUS,
        SHARED_REINDEX,
        EVERY_TENANT_SERVED,
      ]);
      expect(cases.map((found) => found.state)).toEqual(Array(7).fill("pass"));
    },
  );

  it("#818 AC5: a connector keyed by tenant, declared Shared, fails every Shared case: another tenant gets nothing", () => {
    expect(failedOf("shared, keyed by tenant")).toEqual([
      SHARED_CORPUS,
      SHARED_REINDEX,
      EVERY_TENANT_SERVED,
    ]);
  });

  it("#818 AC5: one source with a copy per tenant, refreshed by its own index only, fails the shared re-index", () => {
    expect(failedOf("shared, a copy per tenant")).toEqual([SHARED_REINDEX]);
  });

  // a reranker that fails quietly is never replaced by the retrieval's own order
  it.each(["a reranker that throws", "a reranker that returns no candidate"])(
    "#799 AC2: %s fails every case that retrieves",
    (target) => {
      expect(failedOf(target)).toEqual(RETRIEVING);
    },
  );
});

describe("#818: a tenancy the suite does not know runs no case — it is refused, never an empty pass", () => {
  it.each(["Shared", "per_tenant", ""])("tenancy %j", (tenancy) => {
    expect(() => {
      ragConnectorContract({ ...memoryTarget("odd"), tenancy: tenancy as never });
    }).toThrow(/tenancy is RagTenancy\.PerTenant or RagTenancy\.Shared/u);
  });
});
