/**
 * #695 — the races the contract suites were missing bite: a lease store whose `acquire` checks,
 * then writes, passes every other lease case and fails exactly the races of two takes of a free
 * lease; a fenced-effect store whose lease check takes no lock (and is not made again at its
 * commit) passes the zombie's race of the same key and fails exactly the hand-over during its write.
 * Each fixture runs in a vitest of its own.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PING_CASE } from "../../../src/testing/contracts/define.js";
import { namesOf, runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const LEASE = "lease-check-then-write.contract-fixture.ts";
const EFFECTS = "fencing-unlocked-check.contract-fixture.ts";

const ZOMBIE_RACE =
  "#526 AC3: a write racing its lease's release, the next take and the new holder's write of the same key, round after round: one business row — the old holder's before the take, or it is refused";
const HAND_OVER =
  "#695: the lease released and taken while its holder's write runs: the hand-over waits for the write, or the write is refused — never the take during the work and the write landing after it";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([LEASE, EFFECTS]);
}, 180_000);

describe("#695: the missing races bite", () => {
  it("a lease store that checks, then writes, fails the three races of two takes of a free lease, and nothing else", () => {
    const failed = namesOf(run, LEASE, "fail");

    expect(failed).toHaveLength(3);
    expect(failed.every((name) => name.startsWith("#695: two instances take one"))).toBe(true);
    for (const how of ["never leased", "released", "expired"])
      expect(failed.some((name) => name.includes(`take one ${how} lease`))).toBe(true);
    expect(namesOf(run, LEASE, "pass")).toEqual(
      expect.arrayContaining([
        "a tree's lease held by one instance is not given to the other",
        "a released lease is taken at once with leaseEpoch + 1; another tenant's tree is its own",
        PING_CASE,
      ]),
    );
  });

  it("a fenced effect whose lease check takes no lock fails the hand-over during its write, and passes the zombie's race", () => {
    expect(namesOf(run, EFFECTS, "fail")).toEqual([HAND_OVER]);
    expect(namesOf(run, EFFECTS, "pass")).toContain(ZOMBIE_RACE);
  });
});
