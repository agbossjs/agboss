/**
 * #533 item 1, AC1: the interleaving explorer catches each naive fencing store with a printed
 * minimal schedule (tests/fixtures/contracts/explorer-broken-stores.ts, run by
 * explorer-bites.contract-fixture.ts in a vitest of its own): the invariant each one breaks is named
 * in a failing case of its `interleavings (<name>)` suite, and a broken compare-and-set or finish
 * fails the race that forces its two orders (AC7). The core's own sets pass the same cases
 * (tests/infrastructure/store-conformance.{in-memory,sqlite}.test.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const FIXTURE = "explorer-bites.contract-fixture.ts";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([FIXTURE]);
}, 600_000);

/** The failing cases of `variant`'s suite, with their first error. */
const failuresOf = (variant: string): readonly { name: string; error: string }[] =>
  run.cases
    .filter((found) => found.suites[0] === `interleavings (${variant})` && found.state === "fail")
    .map((found) => ({ name: found.name, error: found.errors[0] ?? "" }));

/** The invariants named by `variant`'s failing world cases. */
const invariantsOf = (variant: string): ReadonlySet<string> =>
  new Set(
    failuresOf(variant).flatMap((failure) => /\): \[([a-z-]+)\]/u.exec(failure.error)?.[1] ?? []),
  );

/** The forced races `variant` fails. */
const racesOf = (variant: string): readonly string[] =>
  failuresOf(variant)
    .filter((failure) => failure.name.startsWith("AC7: "))
    .map((failure) => failure.name.slice("AC7: ".length).split(" — ")[0] ?? "");

const BITES: readonly (readonly [string, string])[] = [
  ["leases on the caller's clock", "one-live-holder"],
  ["a lease live through its expiry instant", "no-stale-write"],
  ["a lease renewed whatever the time", "no-stale-write"],
  ["a renewal from the lease's old end", "no-stale-write"],
  ["a finish that only releases", "no-takeover-of-finished-work"],
  ["a reclaim that keeps the epoch", "one-live-holder"],
  ["calls keyed by the step only", "one-send-per-business-key"],
  ["effects that trust the current lease's token", "no-stale-write"],
  ["effects on the caller's clock", "no-stale-write"],
];

describe("#533 AC1: the interleaving explorer catches each naive store", () => {
  it.each(BITES)("%s: [%s], with a printed minimal schedule", (variant, invariant) => {
    expect(invariantsOf(variant)).toContain(invariant);
    const worldFailures = failuresOf(variant).filter((failure) => !failure.name.startsWith("AC7"));
    for (const failure of worldFailures) {
      expect(failure.error).toMatch(/^interleaving explorer \(/u);
      expect(failure.error).toMatch(/minimal schedule \(\d+ of the \d+ steps found\):\n {3}1\. /u);
    }
  });

  it("a claim that does not compare fails the compare-and-set races it breaks, in the order that shows it", () => {
    expect(racesOf("a claim that does not compare")).toEqual([
      "two claims of the next attempt from one read (#508)",
      "markCompleted of an attempt against a newer attempt's claim (#508)",
      "markFailed of an attempt against a newer attempt's claim (#508)",
    ]);
    const [first] = failuresOf("a claim that does not compare");
    expect(first?.error).toContain("forced as the first call, then the second");
  });

  it("a finish that only releases fails both #520 races; keyed by the step, the business-key race", () => {
    expect(racesOf("a finish that only releases")).toEqual([
      "finish against another instance's take, past the lease (#520)",
      "finish against leaseStateOf, past the lease: finished either way",
    ]);
    expect(racesOf("calls keyed by the step only")).toEqual([
      "two executions recording one business key (#508)",
    ]);
    expect(racesOf("effects that trust the current lease's token")).toEqual([
      "a write against its lease's hand-over and the new holder's write (#500)",
    ]);
  });

  it("a lease store on the caller's clock fails every world it runs in (the lease, the hand-over, the business key)", () => {
    const names = failuresOf("leases on the caller's clock").map((failure) => failure.name);
    expect(names.filter((name) => name.includes("every schedule of 2 instances"))).toHaveLength(3);
    expect(racesOf("leases on the caller's clock")).toEqual([]);
  });
});
