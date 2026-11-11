/**
 * #799 — a store set's report shows what it does not check, never a pass for it
 * (visible-gaps.contract-fixture.ts, in a vitest of its own):
 * - AC3: `interleavings: false` is a skipped case of `interleavings (<name>)`; a set with fenced-effect
 *   or outbound-call stores explored below the floor, or not at all, fails `store set (<name>)`'s
 *   floor case, and one at the floor shows none;
 * - AC5: every contract the set does not claim is a skipped case of `store set (<name>)`; the
 *   queue-watch cases are skipped for a store without `watchQueued`, failed for one with it on one
 *   instance only.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { FLOOR_CASE } from "../../../src/testing/contracts/store-set.cases.js";
import { NOT_EXPLORED_CASE } from "../../../src/testing/contracts/explorer/floor.js";
import { runContractFixtures, type FixtureCase, type FixtureRun } from "./fixture-runs.js";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures(["visible-gaps.contract-fixture.ts"]);
}, 600_000);

const casesOf = (suite: string): readonly FixtureCase[] =>
  run.cases.filter((found) => found.suites[0] === suite);

const stateOf = (suite: string, name: string): FixtureCase["state"] =>
  casesOf(suite).find((found) => found.name === name)?.state;

const UNCLAIMED = (keys: readonly string[]): string[] =>
  keys.map((key) => `does not claim stores.${key}`);

const WATCH_CASES = [
  "a child queued on another instance wakes the watch; it is claimed on the wake-up (#777)",
  "two watches of one instance are woken alike, and each closes on its own (#777)",
];

describe("#799 AC3: the interleaving explorer is never off or starved without a trace", () => {
  it("interleavings: false on leases alone: one skipped case, with the reason", () => {
    const off = casesOf("interleavings (leases alone, explorer off)");

    expect(off.map((found) => [found.name, found.state])).toEqual([[NOT_EXPLORED_CASE, "skip"]]);
    expect(off[0]?.note).toMatch(
      /interleavings: false — no schedule of these stores was searched/u,
    );
    // a set of leases alone may turn it off: no floor case
    expect(stateOf("store set (leases alone, explorer off)", FLOOR_CASE)).toBeUndefined();
  });

  it("interleavings: false on a set with fencing stores: the skipped case, and the floor case fails", () => {
    expect(stateOf("interleavings (fencing, explorer off)", NOT_EXPLORED_CASE)).toBe("skip");
    const floor = casesOf("store set (fencing, explorer off)").find(
      (found) => found.name === FLOOR_CASE,
    );

    expect(floor?.state).toBe("fail");
    expect(floor?.errors[0]).toMatch(
      /\[store-conformance\.interleavings-below-floor\] .*interleavings: false explores nothing/u,
    );
  });

  it("a fencing set below the floor fails the floor case, naming each field below it", () => {
    const floor = casesOf("store set (fencing, below the floor)").find(
      (found) => found.name === FLOOR_CASE,
    );

    expect(floor?.state).toBe("fail");
    expect(floor?.errors[0]).toContain("depth 3 < 4, walks 5 < 20, walkDepth 8 < 16");
  });

  it("a fencing set at the floor: no floor case, every store-set and explorer case passes", () => {
    const set = casesOf("store set (fencing, at the floor)");

    expect(set.map((found) => found.name)).not.toContain(FLOOR_CASE);
    expect(set.filter((found) => found.state === "fail")).toEqual([]);
    expect(casesOf("interleavings (fencing, at the floor)").map((found) => found.state)).toEqual(
      expect.arrayContaining(["pass"]),
    );
    expect(
      casesOf("interleavings (fencing, at the floor)").filter((found) => found.state !== "pass"),
    ).toEqual([]);
  });
});

describe("#799 AC5: what a set does not check is skipped, never passed", () => {
  it("store set (<name>) lists every contract the set does not claim, skipped with the reason", () => {
    const set = casesOf("store set (leases alone, explorer off)");
    const skipped = set.filter((found) => found.state === "skip");

    expect(skipped.map((found) => found.name)).toEqual(
      UNCLAIMED([
        "a2aFile",
        "a2aTask",
        "checkpointSaver",
        "childExecutionQueue",
        "costLedger",
        "executionHistory",
        "executionAuditLog",
        "executionRecord",
        "executionTree",
        "fencedEffect",
        "meshRequest",
        "outboundCall",
        "pausedExecution",
        "rateLimit",
      ]),
    );
    expect(skipped.find((found) => found.name.endsWith("fencedEffect"))?.note).toMatch(
      /listed in without/u,
    );
    expect(skipped.find((found) => found.name.endsWith("rateLimit"))?.note).toMatch(
      /no stores\.rateLimit given: its contract did not run/u,
    );
  });

  it("a set that claims a contract does not list it", () => {
    const names = casesOf("store set (fencing, at the floor)").map((found) => found.name);

    expect(names).not.toContain("does not claim stores.fencedEffect");
    expect(names).toContain("does not claim stores.rateLimit");
  });

  it("the queue-watch cases are skipped for a store without watchQueued, with the reason", () => {
    const queue = casesOf("child execution queue contract (a queue without a watch)");
    const watch = queue.filter((found) => WATCH_CASES.includes(found.name));

    expect(watch.map((found) => found.state)).toEqual(["skip", "skip"]);
    expect(watch[0]?.note).toMatch(
      /the store does not declare StoreCapability\.WatchQueued \(optional\): a child queued on another instance waits for the sweep/u,
    );
    // the queue's other cases ran
    expect(queue.filter((found) => found.state === "pass").length).toBeGreaterThan(5);
  });

  it("a watch on one instance's store only fails the queue-watch cases", () => {
    const queue = casesOf("child execution queue contract (a queue watched on one instance only)");
    const watch = queue.filter((found) => WATCH_CASES.includes(found.name));

    expect(watch.map((found) => found.state)).toEqual(["fail", "fail"]);
    expect(watch[0]?.errors[0]).toMatch(/\[store-conformance\.capability-missing\]/u);
  });
});

describe("#831 AC5: a store declares its capabilities — the suite reads the claim, not the shape", () => {
  const watchOf = (suite: string): readonly FixtureCase[] =>
    casesOf(suite).filter((found) => WATCH_CASES.includes(found.name));

  it("declared and present: the watch cases run and pass", () => {
    expect(
      watchOf("child execution queue contract (a queue declaring its watch)").map(
        (found) => found.state,
      ),
    ).toEqual(["pass", "pass"]);
  });

  it("present but not declared: the watch cases fail, saying to declare it", () => {
    const watch = watchOf("child execution queue contract (a queue with an undeclared watch)");

    expect(watch.map((found) => found.state)).toEqual(["fail", "fail"]);
    expect(watch[0]?.errors[0]).toMatch(
      /\[store-conformance\.capability-not-declared\] the store has watchQueued but does not declare it: give its entry capabilities: \[StoreCapability\.WatchQueued\]/u,
    );
  });

  it("declared but absent: the watch cases fail", () => {
    const watch = watchOf("child execution queue contract (a queue declaring a watch it lacks)");

    expect(watch.map((found) => found.state)).toEqual(["fail", "fail"]);
    expect(watch[0]?.errors[0]).toMatch(
      /\[store-conformance\.capability-missing\] the store declares StoreCapability\.WatchQueued but has no watchQueued/u,
    );
  });
});
