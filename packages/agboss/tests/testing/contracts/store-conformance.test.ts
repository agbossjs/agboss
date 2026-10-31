/**
 * #526 AC2 — `storeConformance` refuses a store set whose fencing contracts do not hold together,
 * before it registers anything: for each fencing contract a set with a lease store leaves out
 * (`[store-conformance.missing-fencing-contract]`, naming it and what its cases prove), a fencing
 * store without its lease store (`lease-store-required`), a contract given and left out
 * (`without-implemented`), a `without` that may not be (`invalid-without`), no store at all
 * (`empty`) — every problem in one `StoreConformanceError`. Sets of coordination stores only, or
 * with no fencing store, need nothing more. (What it registers: published.test.ts and
 * broken-store-set.test.ts, through fixtures.)
 */
import { describe, expect, it } from "vitest";
import {
  storeConformance,
  StoreConformanceError,
  type ConformanceStores,
  type LeftOutContract,
} from "../../../src/testing/contracts/index.js";
import { checkStoreSet } from "../../../src/testing/contracts/store-conformance-check.js";

/** A store that is never built: the checks read which keys a set gives, not what they build. */
const unbuilt = (): never => {
  throw new Error("never built: the set is refused before any case");
};

const FENCING = ["executionLease", "fencedEffect", "outboundCall", "executionLeaseEvent"] as const;
const LEFT_OUT: readonly LeftOutContract[] = [
  "fencedEffect",
  "outboundCall",
  "executionLeaseEvent",
];
const OTHERS = [
  "checkpointSaver",
  "childExecutionQueue",
  "costLedger",
  "executionHistory",
  "executionRecord",
  "executionTree",
  "meshRequest",
  "pausedExecution",
  "rateLimit",
] as const;

/** A set of `keys`, each store never built. */
const setOf = (keys: readonly string[]): ConformanceStores =>
  Object.fromEntries(keys.map((key) => [key, unbuilt]));

/** What `storeConformance` threw for the set: its problems' codes, in order. */
function refusalOf(
  stores: ConformanceStores,
  without?: readonly LeftOutContract[],
): StoreConformanceError {
  try {
    storeConformance({ name: "PostgreSQL", stores, ...(without === undefined ? {} : { without }) });
  } catch (error) {
    if (error instanceof StoreConformanceError) return error;
    throw error;
  }
  throw new Error("storeConformance registered the set: it should have refused it");
}

const codesOf = (error: StoreConformanceError): readonly string[] =>
  error.problems.map((line) => /^\[([^\]]+)\]/u.exec(line)?.[1] ?? line);

/** Whether `checkStoreSet` lets the set through (what `storeConformance` checks first). */
const isAccepted = (claimed: readonly string[], without: readonly string[] = []): boolean => {
  try {
    checkStoreSet({ name: "PostgreSQL", claimed, without });
    return true;
  } catch (error) {
    if (error instanceof StoreConformanceError) return false;
    throw error;
  }
};

describe("#526 AC2: a set with a lease store that leaves a fencing contract out is refused, for each one", () => {
  it.each(LEFT_OUT)("no stores.%s: missing-fencing-contract, naming it", (missing) => {
    const keys = FENCING.filter((key) => key !== missing);

    const error = refusalOf(setOf(keys));

    expect(codesOf(error)).toEqual(["store-conformance.missing-fencing-contract"]);
    expect(error.problems[0]).toContain(`but no stores.${missing}`);
    expect(error.problems[0]).toContain(`list "${missing}" in without when the set has none`);
  });

  it.each(LEFT_OUT)("no stores.%s, the others given too: still refused", (missing) => {
    const keys = [...FENCING.filter((key) => key !== missing), ...OTHERS];

    expect(codesOf(refusalOf(setOf(keys)))).toEqual(["store-conformance.missing-fencing-contract"]);
  });

  it.each(LEFT_OUT)("no stores.%s, listed in without: accepted", (missing) => {
    expect(
      isAccepted(
        FENCING.filter((key) => key !== missing),
        [missing],
      ),
    ).toBe(true);
  });

  it("a lease store alone: three problems, one per contract left out, in one error", () => {
    const error = refusalOf(setOf(["executionLease"]));

    expect(codesOf(error)).toEqual([
      "store-conformance.missing-fencing-contract",
      "store-conformance.missing-fencing-contract",
      "store-conformance.missing-fencing-contract",
    ]);
    expect(error.problems.map((line) => /no stores\.(\w+)/u.exec(line)?.[1])).toEqual(LEFT_OUT);
    expect(error.code).toBe("store-conformance.missing-fencing-contract");
  });

  it("the Redis layout — leases, rate limits, the queue — says it has no fenced effects: accepted", () => {
    expect(isAccepted(["executionLease", "rateLimit", "childExecutionQueue"], [...LEFT_OUT])).toBe(
      true,
    );
    expect(
      isAccepted(
        ["executionLease", "rateLimit", "childExecutionQueue"],
        ["fencedEffect", "outboundCall"],
      ),
    ).toBe(false);
  });

  it("each message says what the missing contract's cases prove", () => {
    const lines = refusalOf(setOf(["executionLease"])).problems;

    expect(lines[0]).toContain(
      "its writes and the lease check in one transaction, a zombie's write refused",
    );
    expect(lines[1]).toContain(
      "its intents fenced by these leases, leaseStateOf's races with a late renewal",
    );
    expect(lines[2]).toContain("every row the core writes to the lease log, read back as it was");
  });

  it("the exact message of one", () => {
    expect(
      refusalOf(setOf(["executionLease", "fencedEffect", "executionLeaseEvent"])).problems,
    ).toEqual([
      '[store-conformance.missing-fencing-contract] "PostgreSQL" has fencing stores but no stores.outboundCall: its cases (its intents fenced by these leases, leaseStateOf\'s races with a late renewal) would not run — give stores.outboundCall, or list "outboundCall" in without when the set has none (an application on these leases then lists none either)',
    ]);
  });
});

describe("#526 AC2: a fencing store without its lease store", () => {
  it.each([
    [["fencedEffect"], 3],
    [["outboundCall"], 3],
    [["fencedEffect", "outboundCall"], 2],
    [["fencedEffect", "outboundCall", "executionLeaseEvent"], 1],
  ] as const)("%j: lease-store-required first, then what else is missing", (keys, problems) => {
    const error = refusalOf(setOf(keys));

    expect(codesOf(error)[0]).toBe("store-conformance.lease-store-required");
    expect(error.problems).toHaveLength(problems);
    expect(error.problems[0]).toBe(
      '[store-conformance.lease-store-required] "PostgreSQL" has a fenced-effect or outbound-call store but no stores.executionLease: they check its leases, so the lease contract runs on the same backend',
    );
  });

  it("a lease log alone is not a fencing set: nothing more needed", () => {
    expect(isAccepted(["executionLeaseEvent"])).toBe(true);
  });
});

describe("#526 AC2: without", () => {
  it.each(LEFT_OUT)("stores.%s given and listed in without: without-implemented", (key) => {
    const error = refusalOf(setOf([...FENCING]), [key]);

    expect(codesOf(error)).toEqual(["store-conformance.without-implemented"]);
    expect(error.problems[0]).toBe(
      `[store-conformance.without-implemented] "PostgreSQL" gives stores.${key} and lists it in without: one or the other`,
    );
  });

  it.each(["executionLease", "rateLimit", "fenced-effect", ""])(
    "%j may not be left out: invalid-without",
    (key) => {
      const error = refusalOf(setOf([...FENCING]), [key as LeftOutContract]);

      expect(codesOf(error)).toEqual(["store-conformance.invalid-without"]);
      expect(error.problems[0]).toContain(
        'only "fencedEffect", "outboundCall", "executionLeaseEvent" may be left out',
      );
    },
  );

  it("every problem at once: a bad without, a contradiction and a missing contract", () => {
    const error = refusalOf(setOf(["executionLease", "fencedEffect"]), [
      "fencedEffect",
      "rateLimit" as LeftOutContract,
    ]);

    expect(codesOf(error)).toEqual([
      "store-conformance.without-implemented",
      "store-conformance.invalid-without",
      "store-conformance.missing-fencing-contract",
      "store-conformance.missing-fencing-contract",
    ]);
  });

  it("without on a set with no lease store: accepted, nothing to leave out", () => {
    expect(isAccepted(["rateLimit"], ["fencedEffect"])).toBe(true);
  });
});

describe("#526 AC2: sets that need nothing more", () => {
  it.each(OTHERS)("stores.%s alone", (key) => {
    expect(isAccepted([key])).toBe(true);
  });

  it("every store of every contract", () => {
    expect(isAccepted([...FENCING, ...OTHERS])).toBe(true);
  });

  it("the four fencing contracts", () => {
    expect(isAccepted([...FENCING])).toBe(true);
  });
});

describe("#526 AC2: an empty set", () => {
  it.each([
    ["no key", {}],
    ["every key undefined", Object.fromEntries(OTHERS.map((key) => [key, undefined]))],
  ])("%s: empty", (_case, stores) => {
    expect(codesOf(refusalOf(stores as ConformanceStores))).toEqual(["store-conformance.empty"]);
  });
});

describe("#526 AC2: StoreConformanceError", () => {
  it("is an Error named so, its code the first problem's, every problem in its message", () => {
    const error = refusalOf(setOf(["outboundCall"]));

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StoreConformanceError");
    expect(error.code).toBe("store-conformance.lease-store-required");
    expect(error.message.split("\n")).toEqual([
      "storeConformance refuses the store set:",
      ...error.problems.map((line) => `  - ${line}`),
    ]);
  });

  it("its code falls back to store-conformance for a problem without one", () => {
    expect(new StoreConformanceError(["something"]).code).toBe("store-conformance");
  });

  it("nothing was built: the refusal comes before any store's factory", () => {
    expect(() => refusalOf(setOf(["executionLease"]))).not.toThrow("never built");
  });
});
