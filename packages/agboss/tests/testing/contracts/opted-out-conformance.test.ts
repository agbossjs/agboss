/**
 * #543 — a store that declares `LeaseCheck.WithoutDoubleChargeProtection` is not conformant for
 * fencing, and no report may suggest it is (the decision on the issue):
 * - AC1: without `acceptWithoutDoubleChargeProtection` a set with an opted-out store fails —
 *   every fencing case of that store and its store-set case, with `StoreConformanceError` naming
 *   the store; with it the fencing cases are skipped with "store opted out of the lease check: no
 *   double-charge protection", every other case runs, and `gives NO double-charge protection for …`
 *   passes in the set's suite;
 * - AC2: the opt-out is the author's statement: an opted-out store that is atomic anyway (the
 *   in-memory store with the flag on) gets no pass for a fencing case either, while the same cases
 *   pass on the core's atomic store and fail on an honest check-then-write store left un-flagged;
 * - what the opt-out does not waive still runs: an honest check-then-write store, accepted, still
 *   fails the races of one write per key;
 * - a flag nobody needs (no store opts out) fails, so it cannot hide in a sound set's report.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { OPTED_OUT_REASON } from "../../../src/testing/contracts/fencing-gate.js";
import { runContractFixtures, type FixtureCase, type FixtureRun } from "./fixture-runs.js";

const ACCEPTED = "fencing-opted-out.contract-fixture.ts";
const REFUSED = "opted-out-refused.contract-fixture.ts";
const HONEST = "opted-out-check-then-write.contract-fixture.ts";
const UNUSED_FLAG = "opted-out-flag-unused.contract-fixture.ts";
const UNFLAGGED = "fencing-check-then-write.contract-fixture.ts";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([ACCEPTED, REFUSED, HONEST, UNUSED_FLAG, UNFLAGGED]);
}, 180_000);

const casesOf = (file: string, suite: string): readonly FixtureCase[] =>
  run.cases.filter((found) => found.file === file && found.suites[0] === suite);

const named = (cases: readonly FixtureCase[], state: FixtureCase["state"]): string[] =>
  cases.filter((found) => found.state === state).map((found) => found.name);

/** The cases of the outbound-call contract the opt-out takes out: skipped in the accepted set. */
const outboundFencing = (): string[] =>
  named(casesOf(ACCEPTED, "outbound call contract (an opted-out outbound-call store)"), "skip");

describe("#543 AC1: an opted-out store without acceptWithoutDoubleChargeProtection", () => {
  it("fails every fencing case of that store, naming it, and its store-set case", () => {
    const outbound = casesOf(REFUSED, "outbound call contract (an opt-out not accepted)");
    const failed = outbound.filter((found) => found.state === "fail");

    expect(failed.map((found) => found.name)).toEqual(outboundFencing());
    expect(failed.length).toBeGreaterThan(10);
    for (const found of failed)
      expect(found.errors.join("\n")).toContain(
        "[store-conformance.opted-out-store] UncheckedCalls declares LeaseCheck.WithoutDoubleChargeProtection",
      );
    expect(named(casesOf(REFUSED, "store set (an opt-out not accepted)"), "fail")).toEqual([
      "the outbound-call store is on the backend of the lease store it checks, or opts out",
    ]);
  });

  it("runs every other case of that store, and the other stores' cases, as for any store", () => {
    const outbound = casesOf(REFUSED, "outbound call contract (an opt-out not accepted)");
    const others = run.cases.filter(
      (found) =>
        found.file === REFUSED &&
        !found.suites[0]?.startsWith("outbound call contract") &&
        !found.suites[0]?.startsWith("store set") &&
        !found.suites[0]?.startsWith("interleavings"),
    );

    expect(named(outbound, "pass").length).toBeGreaterThan(20);
    expect(others.filter((found) => found.state !== "pass")).toEqual([]);
  });

  it("#533: the interleaving explorer refuses it too — its outbound-call worlds and races fail, the lease world runs", () => {
    const explored = run.cases.filter(
      (found) => found.file === REFUSED && found.suites[0]?.startsWith("interleavings") === true,
    );
    const failed = explored.filter((found) => found.state === "fail");

    expect(failed.length).toBeGreaterThan(0);
    expect(
      failed.every((found) =>
        found.errors.join("").includes("[store-conformance.opted-out-store]"),
      ),
    ).toBe(true);
    expect(failed.some((found) => found.name.startsWith("every lease operation"))).toBe(false);
    expect(
      explored
        .filter((found) => found.name.startsWith("every lease operation"))
        .every((found) => found.state === "pass"),
    ).toBe(true);
  });
});

describe("#543 AC1: the opt-out accepted", () => {
  it("skips each fencing case with the reason, fails nothing, and shows the opt-out in the set", () => {
    const skipped = run.cases.filter(
      (found) =>
        found.file === ACCEPTED &&
        found.state === "skip" &&
        found.suites[0]?.startsWith("store set") !== true,
    );

    expect(skipped.length).toBeGreaterThan(10);
    expect(skipped.every((found) => found.note === OPTED_OUT_REASON)).toBe(true);
    expect(run.cases.filter((found) => found.file === ACCEPTED && found.state === "fail")).toEqual(
      [],
    );
    expect(
      named(casesOf(ACCEPTED, "store set (an opted-out outbound-call store)"), "pass"),
    ).toEqual(expect.arrayContaining(["gives NO double-charge protection for outbound calls"]));
  });

  it("the atomic fenced-effect store of the same set runs all its fencing cases; its line in the set is skipped", () => {
    const effects = casesOf(ACCEPTED, "fenced effect contract (an opted-out outbound-call store)");
    const set = casesOf(ACCEPTED, "store set (an opted-out outbound-call store)");

    expect(effects.filter((found) => found.state !== "pass")).toEqual([]);
    expect(named(set, "skip")).toEqual([
      "the outbound-call store is on the backend of the lease store it checks, or opts out",
      "gives NO double-charge protection for fenced effects",
    ]);
  });
});

describe("#543 AC2: the opt-out is the author's statement, never overridden", () => {
  it("an atomic store with the flag on passes no fencing case; the same cases pass on the core's own store", () => {
    const skippedHere = outboundFencing();
    const onTheCore = named(
      casesOf(UNUSED_FLAG, "outbound call contract (an opt-out accepted that nobody declares)"),
      "pass",
    );

    expect(skippedHere.length).toBeGreaterThan(10);
    expect(onTheCore).toEqual(expect.arrayContaining(skippedHere));
  });

  it("an honest check-then-write store: its fencing cases skipped and the opt-out shown when it says so, its key races still failing; the zombie race failing when it does not say so", () => {
    const honest = casesOf(HONEST, "fenced effect contract (an honest check-then-write store)");
    const unflagged = casesOf(UNFLAGGED, "fenced effect contract (check-then-write effects)");

    // what the opt-out does not excuse: one write per key, a lease or not — these still run, and fail
    expect(named(honest, "fail")).toEqual([
      "AC3: two instances call one key at once: one Ran, one Replayed, the write runs once",
      "#508: two instances racing on one business key from two executions write once",
      "#508 AC3: a concurrent call with another fingerprint under one business key is refused, not joined",
    ]);
    // every other case the un-flagged store fails is a fencing case: skipped once it says so
    const fencingFailures = named(unflagged, "fail").filter(
      (name) => !named(honest, "fail").includes(name),
    );
    expect(fencingFailures.length).toBeGreaterThan(0);
    expect(named(honest, "skip")).toEqual(expect.arrayContaining(fencingFailures));
    expect(named(casesOf(HONEST, "store set (an honest check-then-write store)"), "pass")).toEqual(
      expect.arrayContaining([
        "gives NO double-charge protection for fenced effects",
        "gives NO double-charge protection for outbound calls",
      ]),
    );
  });
});

describe("#543: a flag no store needs", () => {
  it("fails the set's case that checks it, so a sound set's report never reads as opted out", () => {
    const set = casesOf(UNUSED_FLAG, "store set (an opt-out accepted that nobody declares)");

    expect(named(set, "fail")).toEqual([
      "accepts an opt-out only where a store declares one (acceptWithoutDoubleChargeProtection)",
    ]);
    expect(named(set, "skip")).toEqual([
      "gives NO double-charge protection for fenced effects",
      "gives NO double-charge protection for outbound calls",
    ]);
  });
});
