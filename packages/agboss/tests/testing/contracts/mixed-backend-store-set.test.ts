/**
 * #542 (found in #526's acceptance) — `store set (<name>)` compares each fencing store with the
 * set's own lease store, not only with the lease store inside its contract's target: a set of
 * in-memory leases and SQLite fenced effects passes every contract on its own, yet cannot assemble
 * (`[application.store-backend-mismatch]`) — its fenced-effect case fails, naming both stores and
 * both backends, and nothing else does.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const MIXED = "fencing-mixed-backends.contract-fixture.ts";
const SET = "store set (in-memory leases, SQLite fenced effects)";
const EFFECT_CASE =
  "the fenced-effect store is on the backend of the lease store it checks, or opts out";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([MIXED]);
}, 180_000);

describe("#542: a fencing store of another backend than the set's lease store", () => {
  it("fails the store set's fenced-effect case only — every contract of the set passes", () => {
    const failed = run.cases.filter((found) => found.state === "fail");

    expect(run.isFailed).toBe(true);
    expect(failed.map((found) => [found.suites[0], found.name])).toEqual([[SET, EFFECT_CASE]]);
    expect(run.cases.filter((found) => found.state === "pass").length).toBeGreaterThan(100);
  });

  it("names the store, the set's lease store and its backend", () => {
    const [failed] = run.cases.filter((found) => found.state === "fail");

    expect(failed?.errors.join("\n")).toContain(
      'SqliteFencedEffectRepository checks the leases of the set\'s lease store InMemoryExecutionLeaseRepository (backend "in-memory") in its own transaction: one backend',
    );
  });
});
