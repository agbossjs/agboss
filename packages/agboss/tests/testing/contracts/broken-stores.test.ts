/**
 * #481 AC2: a deliberately broken store fails the published suite of its contract — each fixture
 * (tests/fixtures/contracts/*.contract-fixture.ts) runs one suite against one broken store in a
 * vitest of its own; the run fails, the cases of the broken rule are among the failures, and the
 * rules the store keeps still pass (the report is per rule). Also: a store on the wall clock fails
 * the time-based cases of the lease contract (the suite owns the clock).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PING_CASE } from "../../../src/testing/contracts/define.js";
import { namesOf, runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const LEASE = "lease-ignoring-holder.contract-fixture.ts";
const QUEUE = "queue-claiming-twice.contract-fixture.ts";
const RECORD = "record-losing-update.contract-fixture.ts";
const TREE = "tree-keeping-deleted-rows.contract-fixture.ts";
const WALL_CLOCK = "lease-on-wall-clock.contract-fixture.ts";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([LEASE, QUEUE, RECORD, TREE, WALL_CLOCK]);
}, 120_000);

describe("#481 AC2: a broken store fails the published suite of its contract", () => {
  it("the run of the broken stores fails", () => {
    expect(run.isFailed).toBe(true);
    expect(new Set(run.cases.map((found) => found.file))).toEqual(
      new Set([LEASE, QUEUE, RECORD, TREE, WALL_CLOCK]),
    );
  });

  it("a lease store that ignores a valid holder fails the lease contract", () => {
    expect(namesOf(run, LEASE, "fail")).toEqual(
      expect.arrayContaining([
        "a tree's lease held by one instance is not given to the other",
        "releasing a lost lease leaves the new holder's",
        "a live holder renews every third of the lease: the waiting call waits",
      ]),
    );
    expect(namesOf(run, LEASE, "pass")).toContain(PING_CASE);
  });

  it("a queue that claims a row twice fails the child execution queue contract", () => {
    expect(namesOf(run, QUEUE, "fail")).toContain("the deepest first, then the longest waiting");
    expect(namesOf(run, QUEUE, "pass")).toEqual(
      expect.arrayContaining(["a child is queued once", PING_CASE]),
    );
  });

  it("a record store that loses an update fails the execution record contract", () => {
    expect(namesOf(run, RECORD, "fail")).toContain(
      "compare-and-set: the write lands only from the expected status (S66 h)",
    );
    expect(namesOf(run, RECORD, "pass")).toContain(
      "a thread made on one instance is known to the other, with its owner",
    );
  });

  it("a tree store that keeps deleted rows fails the execution tree contract", () => {
    expect(namesOf(run, TREE, "fail")).toEqual([
      "removed at the end: deleting the tree removes its keys only",
    ]);
  });

  it("each failure names the suite of its contract and its target", () => {
    const failed = run.cases.filter((found) => found.state === "fail");

    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((found) => found.errors.length > 0)).toBe(true);
    expect(run.cases.find((found) => found.file === TREE)?.suites[0]).toBe(
      "execution tree contract (a tree store that keeps deleted rows)",
    );
  });
});

describe("#481: a store reading Date.now() instead of the seam's clock", () => {
  it("fails the time-based cases of the lease contract, and only those", () => {
    expect(namesOf(run, WALL_CLOCK, "fail")).toEqual(
      expect.arrayContaining([
        "a tree's lease held by one instance is not given to the other",
        "past the lease the other takes it with leaseEpoch + 1, and the old holder's renew is false",
        "a holder frozen past the lease loses it to the waiting instance: its signal aborts",
      ]),
    );
    expect(namesOf(run, WALL_CLOCK, "pass")).toEqual(
      expect.arrayContaining([
        "a released lease is taken at once with leaseEpoch + 1; another tenant's tree is its own",
        PING_CASE,
      ]),
    );
  });
});
