/**
 * #694: a store set with a lease store and no outbound-call store — the coordination stores of
 * Redis, `without: ["fencedEffect", "outboundCall", …]` — is explored on its lease store alone:
 * every schedule of two instances and seeded walks of three over every lease operation (no
 * `leaseStateOf`), every skew, and the two lease races. The sound in-memory store passes; leases on
 * the caller's clock and a finish that only releases fail with the invariant they break
 * (explorer-lease-only.contract-fixture.ts, in a vitest of its own).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures(["explorer-lease-only.contract-fixture.ts"]);
}, 600_000);

const casesOf = (variant: string) =>
  run.cases.filter((found) => found.suites[0] === `interleavings (${variant})`);

const failedOf = (variant: string) => casesOf(variant).filter((found) => found.state === "fail");

describe("#694: the explorer on a lease store alone", () => {
  it("AC1: registers the lease world (every schedule, the walks) and the two lease races — and passes on a sound store", () => {
    expect(casesOf("leases alone").map((found) => found.name.split(":")[0])).toEqual([
      "every lease operation",
      "every lease operation",
      "AC7",
      "AC7",
    ]);
    expect(casesOf("leases alone").map((found) => found.name)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^every lease operation: every schedule of 2 instances up to 6 steps/u,
        ),
        expect.stringMatching(/^every lease operation: 20 seeded walks of 3 instances/u),
        expect.stringMatching(/^AC7: finish against another instance's take, past the lease/u),
        expect.stringMatching(/^AC7: release against another instance's take of a live lease/u),
      ]),
    );
    expect(casesOf("leases alone").map((found) => found.state)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
  });

  it("AC2: leases on the caller's clock break one-live-holder, with a printed minimal schedule", () => {
    const failed = failedOf("leases alone on the caller's clock");
    expect(failed.length).toBeGreaterThan(0);
    const [first] = failed;
    expect(first?.errors[0]).toMatch(/\): \[one-live-holder\]/u);
    expect(first?.errors[0]).toMatch(/minimal schedule \(\d+ of the \d+ steps found\):\n {3}1\. /u);
  });

  it("AC2: a finish that only releases breaks no-takeover-of-finished-work and the #520 race", () => {
    const failed = failedOf("leases alone, a finish that only releases");
    expect(
      failed.some((found) => (found.errors[0] ?? "").includes("[no-takeover-of-finished-work]")),
    ).toBe(true);
    expect(
      failed.filter((found) => found.name.startsWith("AC7: ")).map((found) => found.name),
    ).toEqual([
      expect.stringMatching(
        /^AC7: finish against another instance's take, past the lease \(#520\)/u,
      ),
    ]);
  });

  it("no lease store and no fencing store: nothing is registered", () => {
    expect(casesOf("no stores")).toEqual([]);
  });
});
