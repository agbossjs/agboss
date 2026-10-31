/**
 * #526 acceptance — `storeConformance` corners past the handoff's: a store under a key that names
 * no contract (a JavaScript project's typo, `rateLimits`) would never be tested, so it is refused
 * (#542, `[store-conformance.unknown-store]`) — alone, beside a sound fencing set, and with the
 * other problems in one error; a key given as `undefined` is no store (a fencing set that names one
 * so is missing it); `without` listed twice is one left-out contract.
 */
import { describe, expect, it } from "vitest";
import {
  storeConformance,
  StoreConformanceError,
  type ConformanceStores,
  type LeftOutContract,
} from "../../../src/testing/contracts/index.js";
import { checkStoreSet } from "../../../src/testing/contracts/store-conformance-check.js";

const unbuilt = (): never => {
  throw new Error("never built: the set is refused before any case");
};

const FENCING = ["executionLease", "fencedEffect", "outboundCall", "executionLeaseEvent"] as const;

/** A set of `keys` (as a JavaScript project may give them: no type checks the keys), unbuilt. */
const setOf = (
  keys: readonly string[],
  extra: Record<string, unknown> = {},
): ConformanceStores => ({ ...Object.fromEntries(keys.map((key) => [key, unbuilt])), ...extra });

/** The problems `storeConformance` refuses the set with (a set it took would register suites). */
function problemsOf(
  stores: ConformanceStores,
  without?: readonly LeftOutContract[],
): readonly string[] {
  try {
    storeConformance({ name: "PostgreSQL", stores, ...(without === undefined ? {} : { without }) });
  } catch (error) {
    if (error instanceof StoreConformanceError) return error.problems;
    throw error;
  }
  throw new Error("storeConformance registered the set: it should have refused it");
}

const codesOf = (problems: readonly string[]): readonly string[] =>
  problems.map((line) => /^\[([^\]]+)\]/u.exec(line)?.[1] ?? line);

describe("#542: a store under a key that names no contract", () => {
  it("alone: refused, naming the key and the contracts it may be", () => {
    const problems = problemsOf(setOf(["rateLimits"]));

    expect(codesOf(problems)).toEqual(["store-conformance.unknown-store"]);
    expect(problems[0]).toContain(
      '"PostgreSQL" gives stores.rateLimits, which names no contract: its store would never be tested',
    );
    expect(problems[0]).toContain("pausedExecution, rateLimit");
  });

  it("beside a sound fencing set: still refused — one typo is no store tested", () => {
    const problems = problemsOf(setOf([...FENCING, "pausedExecutions"]));

    expect(codesOf(problems)).toEqual(["store-conformance.unknown-store"]);
  });
});

describe("#526 acceptance: what counts as a store, and without", () => {
  it("a fencing key given as undefined is no store: the set is missing that contract", () => {
    const problems = problemsOf(
      setOf(["executionLease", "fencedEffect", "executionLeaseEvent"], { outboundCall: undefined }),
    );

    expect(codesOf(problems)).toEqual(["store-conformance.missing-fencing-contract"]);
    expect(problems[0]).toContain("no stores.outboundCall");
  });

  it("a contract listed twice in without is left out once: no problem of its own", () => {
    expect(() => {
      checkStoreSet({
        name: "PostgreSQL",
        claimed: ["executionLease", "outboundCall", "executionLeaseEvent"],
        without: ["fencedEffect", "fencedEffect"],
      });
    }).not.toThrow();
  });
});
