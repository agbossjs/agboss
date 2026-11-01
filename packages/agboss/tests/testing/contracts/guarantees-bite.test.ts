/**
 * Acceptance of #508, #505 and #483: the contract cases behind the payment-grade guarantees bite.
 * Each naive store (tests/fixtures/contracts/naive-guarantees.ts) breaks one guarantee as a
 * hand-written store would — a business key dropped, a stale token trusted, a slot never counted,
 * a check-then-act save, a read-then-write ledger — and the cases of that guarantee fail on it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { namesOf, runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const FIXTURE = "naive-guarantees.contract-fixture.ts";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([FIXTURE]);
}, 120_000);

/** The failed cases of the suite of `target`. */
const failedOf = (target: string): readonly string[] =>
  run.cases
    .filter((found) => found.state === "fail" && found.suites[0]?.includes(`(${target})`))
    .map((found) => found.name);

describe("acceptance: a naive store fails the cases of the guarantee it breaks", () => {
  it("#508 AC1–AC2: keyed by the step only, two executions of one order write twice", () => {
    expect(failedOf("effects keyed by the step only")).toEqual(
      expect.arrayContaining([
        "#508: one business key from two executions (two scopes) runs once; the second replays it, naming the first",
        "#508: two instances racing on one business key from two executions write once",
      ]),
    );
    expect(failedOf("calls keyed by the step only").length).toBeGreaterThan(0);
  });

  it("#500 / #505 AC5: trusting the current lease, a zombie's stale token writes", () => {
    expect(failedOf("effects trusting the current lease")).toEqual(
      expect.arrayContaining([
        "AC2: a lower token is refused even when its key exists: the write not run, the stored result not returned",
        "#508: a stale token is refused even when its business key has a stored result — the zombie gets no receipt",
      ]),
    );
    expect(failedOf("calls trusting the current lease")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^AC5: .* with a token below the lease's after a takeover is refused/,
        ),
      ]),
    );
  });

  it("#483 AC2: a rate limit that never counts gives a slot past maxSlots", () => {
    expect(failedOf("a rate limit that never counts")).toContain(
      "maxSlots slots under one key, then none until one is released",
    );
  });

  it("#483 AC4: a look-then-write mesh store admits a retry twice", () => {
    expect(failedOf("mesh requests looked up, then written")).toContain(
      "one save of a key wins, on two instances",
    );
  });

  it("#483 AC1: a read-then-write ledger loses one pod's spend", () => {
    expect(failedOf("a ledger that reads, then writes")).toContain(
      "concurrent saves of two instances lose nothing",
    );
  });

  it("#634: a read-then-write ledger loses a save in some of several counters", () => {
    expect(failedOf("a ledger that reads, then writes")).toContain(
      "concurrent saves of two instances to several counters lose nothing in any of them",
    );
  });

  it("each naive store keeps the rules it does not break: its ping passes", () => {
    expect(namesOf(run, FIXTURE, "pass").length).toBeGreaterThan(0);
  });
});
