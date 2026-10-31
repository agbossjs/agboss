/**
 * #526 AC3, AC6 (and AC1, AC2 through the store set's cases) — a deliberately broken fencing store
 * fails `storeConformance`: each fixture (tests/fixtures/contracts/fencing-*.contract-fixture.ts)
 * runs a store set of the four fencing contracts with one broken store, in a vitest of its own.
 * The run fails, the cases of the rule the store breaks are among the failures, and the rest of
 * the set passes — so the report names the rule:
 *
 * - check, then write (AC3): the lease and the key read, a round trip, then the write — a zombie's
 *   write and the new holder's both land, a double charge;
 * - business rows outside the transaction (AC3): rolled back by nothing;
 * - `leaseStateOf` as a read, then a close (AC3): a late renewal and the close both win;
 * - a lease log on the row schema of before #508 (AC6), as agbossjs/postgres's was;
 * - stores that declare no backend, or another than their leases' (AC1, the store set's cases);
 * - a store that opts out of the atomic lease check: nothing fails.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PING_CASE } from "../../../src/testing/contracts/define.js";
import { namesOf, runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const CHECK_THEN_WRITE = "fencing-check-then-write.contract-fixture.ts";
const ROWS_OUTSIDE = "fencing-rows-outside.contract-fixture.ts";
const LEASE_CLOSE = "fencing-lease-close.contract-fixture.ts";
const OLD_LEASE_LOG = "fencing-old-lease-log.contract-fixture.ts";
const BACKENDS = "fencing-backends.contract-fixture.ts";
const OPTED_OUT = "fencing-opted-out.contract-fixture.ts";

const FIXTURES = [CHECK_THEN_WRITE, ROWS_OUTSIDE, LEASE_CLOSE, OLD_LEASE_LOG, BACKENDS, OPTED_OUT];

const ZOMBIE_RACE =
  "#526 AC3: a write racing its lease's release, the next take and the new holder's write of the same key, round after round: one business row — the old holder's before the take, or it is refused";
const TWO_INSTANCES =
  "AC3: two instances call one key at once: one Ran, one Replayed, the write runs once";
const ROLLBACK =
  "a throwing write rolls its business row back, its error rethrown as it is; the next call runs it";
const SEEN_AFTER_COMMIT =
  "a business row is seen by another instance only once the effect committed";
const TOO_LARGE = "a result above maxResultSize is refused and its write rolled back";
const RENEWAL_RACE =
  "#508: leaseStateOf of an expired lease racing its holder's renewal, round after round: renewed and Live, or Superseded and not renewable — never both";
const TAKE_RACE =
  "#508: leaseStateOf of an expired lease racing another instance's take, round after round: the old token is not Live, the take stands and is held";
const KIND_CASES = [
  "#526 AC6: every row kind, reason, site, outcome and status the core writes is read back as it was, in the order saved",
  "#508: a lease-superseded row keeps the lease it closed (supersededLease)",
  "#508: a superseded row keeps the attempt that took the intent over (supersededBy)",
  "#508: a business key's replay keeps the step it replayed (replayedFrom), on a fenced-effect row and an outbound-call row",
];
const STORE_SET_CASES = [
  "the lease store declares its backend (static backend)",
  "the fenced-effect store is on the backend of the lease store it checks, or opts out",
  "the outbound-call store is on the backend of the lease store it checks, or opts out",
];

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures(FIXTURES);
}, 180_000);

/** The cases of `file` under the suite `suite` (its first describe) in `state`. */
const under = (file: string, suite: string, state: "pass" | "fail"): readonly string[] =>
  run.cases
    .filter((found) => found.file === file && found.suites[0] === suite && found.state === state)
    .map((found) => found.name);

/** The suites of `file` with a failing case. */
const failingSuites = (file: string): ReadonlySet<string | undefined> =>
  new Set(
    run.cases
      .filter((found) => found.file === file && found.state === "fail")
      .map((found) => found.suites[0]),
  );

describe("#526 AC3: a broken fencing store fails storeConformance", () => {
  it("the run fails, every fixture ran its whole set", () => {
    expect(run.isFailed).toBe(true);
    expect(new Set(run.cases.map((found) => found.file))).toEqual(new Set(FIXTURES));
    // four contracts and the store set's suite; the backends' set leaves its lease log out
    for (const file of FIXTURES)
      expect(
        new Set(run.cases.filter((found) => found.file === file).map((found) => found.suites[0]))
          .size,
        file,
      ).toBe(file === BACKENDS ? 4 : 5);
  });

  it("check, then write: the zombie's race fails — one business row is two — and the two-instance race", () => {
    const suite = "fenced effect contract (check-then-write effects)";

    expect(under(CHECK_THEN_WRITE, suite, "fail")).toEqual(
      expect.arrayContaining([ZOMBIE_RACE, TWO_INSTANCES]),
    );
    expect(under(CHECK_THEN_WRITE, suite, "pass")).toEqual(
      expect.arrayContaining([ROLLBACK, PING_CASE]),
    );
    expect(failingSuites(CHECK_THEN_WRITE)).toEqual(new Set([suite]));
  });

  it("business rows outside the transaction: the rollbacks and the zombie's race fail", () => {
    const suite = "fenced effect contract (rows outside the transaction)";

    expect(under(ROWS_OUTSIDE, suite, "fail")).toEqual(
      expect.arrayContaining([ROLLBACK, SEEN_AFTER_COMMIT, TOO_LARGE, ZOMBIE_RACE]),
    );
    expect(under(ROWS_OUTSIDE, suite, "pass")).toContain(PING_CASE);
    expect(failingSuites(ROWS_OUTSIDE)).toEqual(new Set([suite]));
  });

  it("a check-then-write lease close: leaseStateOf's races with a renewal and a take fail, nothing else", () => {
    const suite = "outbound call contract (check-then-write lease close)";

    expect(under(LEASE_CLOSE, suite, "fail")).toEqual([RENEWAL_RACE, TAKE_RACE]);
    expect(failingSuites(LEASE_CLOSE)).toEqual(new Set([suite]));
  });

  it("each failure names its contract and its set, with why", () => {
    const failed = run.cases.filter((found) => found.state === "fail");

    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((found) => found.errors.length > 0)).toBe(true);
    expect(failed.every((found) => / \(.+\)$/u.test(found.suites[0] ?? ""))).toBe(true);
  });
});

describe("#526 AC6: a lease log on the row schema of before #508 fails the lease event contract", () => {
  it("exactly the cases of every row kind fail; the older cases and ping pass", () => {
    const suite = "lease event contract (a lease log of before #508)";

    expect(under(OLD_LEASE_LOG, suite, "fail")).toEqual(KIND_CASES);
    expect(under(OLD_LEASE_LOG, suite, "pass")).toEqual(
      expect.arrayContaining([
        "a saved row is read back as it was, on the other instance",
        "#505: an outbound call's row is read back as it was",
        "#501: a refused fenced-effect row keeps the token it observed; a row without an optional field comes back without it — absent, never null",
        PING_CASE,
      ]),
    );
    expect(failingSuites(OLD_LEASE_LOG)).toEqual(new Set([suite]));
  });

  it("the lease event contract of every other set passes them", () => {
    for (const [file, name] of [
      [CHECK_THEN_WRITE, "check-then-write effects"],
      [OPTED_OUT, "an opted-out outbound-call store"],
    ] as const)
      expect(under(file, `lease event contract (${name})`, "pass")).toEqual(
        expect.arrayContaining(KIND_CASES),
      );
  });
});

describe("#526 AC1, AC2: the store set's cases", () => {
  it("no backend on the lease store, another on the fenced-effect store, none on the outbound-call store: the three fail", () => {
    const suite = "store set (stores of no backend or another)";

    expect(under(BACKENDS, suite, "fail")).toEqual(STORE_SET_CASES);
    expect(failingSuites(BACKENDS)).toEqual(new Set([suite]));
  });

  it("their messages name the class and what is wrong", () => {
    const errors = run.cases
      .filter((found) => found.file === BACKENDS && found.state === "fail")
      .map((found) => found.errors.join("\n"));

    expect(errors[0]).toContain("UndeclaredLeases, the lease store, declares no static backend");
    expect(errors[1]).toContain(
      "ElsewhereEffects checks the leases of InMemoryExecutionLeaseRepository in its own transaction: one backend",
    );
    expect(errors[2]).toContain("UndeclaredCalls, a fencing store, declares no static backend");
  });

  it("a store that opts out of the atomic lease check: the whole set passes", () => {
    expect(run.cases.filter((found) => found.file === OPTED_OUT && found.state !== "pass")).toEqual(
      [],
    );
    expect(under(OPTED_OUT, "store set (an opted-out outbound-call store)", "pass")).toEqual(
      STORE_SET_CASES,
    );
  });

  it("the sets of sound stores pass their store set's cases", () => {
    for (const [file, name] of [
      [CHECK_THEN_WRITE, "check-then-write effects"],
      [LEASE_CLOSE, "check-then-write lease close"],
      [OLD_LEASE_LOG, "a lease log of before #508"],
    ] as const)
      expect(under(file, `store set (${name})`, "pass")).toEqual(STORE_SET_CASES);
  });
});

describe("#526 AC3: the zombie's race on the core's stores", () => {
  it("is a case of every set's fenced effect contract, and the sound ones pass it", () => {
    for (const [file, name] of [
      [LEASE_CLOSE, "check-then-write lease close"],
      [OLD_LEASE_LOG, "a lease log of before #508"],
      [OPTED_OUT, "an opted-out outbound-call store"],
    ] as const)
      expect(under(file, `fenced effect contract (${name})`, "pass")).toContain(ZOMBIE_RACE);
    expect(namesOf(run, BACKENDS, "pass")).toContain(ZOMBIE_RACE);
  });
});
