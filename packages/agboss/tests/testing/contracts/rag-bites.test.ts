/**
 * #700 AC2 — the RAG connector contract bites: a sound connector passes every case, and each
 * connector broken one way fails exactly the cases of its rule — ignoring the tenant, folding its id,
 * appending on re-index, ignoring topK, ignoring the signal, reporting NaN.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const FIXTURE = "rag-bites.contract-fixture.ts";

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

describe("#700 AC2: a connector that breaks a rule fails the RAG contract suite", () => {
  it("the sound connector passes every case (7)", () => {
    const cases = run.cases.filter((found) => found.suites[0] === "RAG connector contract (sound)");
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
});
