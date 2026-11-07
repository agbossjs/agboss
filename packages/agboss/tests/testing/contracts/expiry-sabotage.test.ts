/**
 * #534 AC1 acceptance: the lease's boundary cases bite. Each naive store (naive-expiry.ts) lets a
 * lease live on for its holder — by holder and epoch only, or through `expiresAt` (`>=`) — and the
 * cases at the expiry (and after it, for the first kind) fail on it; 1 ms before, all pass.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runContractFixtures, type FixtureCase, type FixtureRun } from "./fixture-runs.js";

const FIXTURE = "naive-expiry.contract-fixture.ts";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([FIXTURE]);
}, 120_000);

/** The #534 cases of the suite of `target` at `edge`. */
const edgeCasesOf = (target: string, edge: string): readonly FixtureCase[] =>
  run.cases.filter(
    (found) =>
      found.suites[0]?.endsWith(`(${target})`) === true &&
      found.name.startsWith("#534:") &&
      found.name.includes(edge),
  );

const statesOf = (cases: readonly FixtureCase[]) =>
  cases.map((found) => [found.name, found.state] as const);

/** Each naive target, its contract's count of #534 cases per edge, and whether it lets +1 ms live. */
const TARGETS = [
  ["leases by holder and epoch only", 8, true],
  ["leases live through expiresAt", 8, false],
  ["effects fenced by holder and epoch only", 2, true],
  ["effects fenced through expiresAt", 2, false],
  ["calls fenced by holder and epoch only", 9, true],
  ["calls fenced through expiresAt", 9, false],
] as const;

describe("#534 AC1: the boundary cases fail on a store that lets the lease live on for its holder", () => {
  it.each(TARGETS)("%s: every case exactly at the expiry fails", (target, count) => {
    const atExpiry = edgeCasesOf(target, "exactly at its expiry");

    expect(atExpiry.length).toBeGreaterThanOrEqual(count);
    expect(statesOf(atExpiry)).toEqual(atExpiry.map((found) => [found.name, "fail"]));
  });

  it.each(TARGETS)(
    "%s: 1 ms after the expiry fails only when the store ignores the time",
    (target, count, isLiveAfter) => {
      const after = edgeCasesOf(target, "1 ms after its expiry");
      const expected = isLiveAfter ? "fail" : "pass";

      expect(after.length).toBeGreaterThanOrEqual(count);
      expect(statesOf(after)).toEqual(after.map((found) => [found.name, expected]));
    },
  );

  it.each(TARGETS)(
    "%s: 1 ms before the expiry every case passes — the naive store keeps the rest",
    (target, count) => {
      const before = edgeCasesOf(target, "1 ms before its expiry");

      expect(before.length).toBe(count);
      expect(statesOf(before)).toEqual(before.map((found) => [found.name, "pass"]));
    },
  );
});

describe("#534 acceptance: a renewal's new end counts from the renewal", () => {
  const RENEWED_FROM_NOW = "#534: a renewal 29.999 s into the lease moves its end";
  const caseOf = (target: string) =>
    run.cases.find(
      (found) =>
        found.suites[0]?.endsWith(`(${target})`) === true &&
        found.name.startsWith(RENEWED_FROM_NOW),
    );

  it("fails on a store that extends the lease from its old end, which passes every edge case", () => {
    const edges = run.cases.filter(
      (found) =>
        found.suites[0]?.endsWith("(leases renewed from their old end)") === true &&
        found.name.startsWith("#534:") &&
        !found.name.startsWith(RENEWED_FROM_NOW),
    );

    expect(caseOf("leases renewed from their old end")?.state).toBe("fail");
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.filter((found) => found.state !== "pass")).toEqual([]);
  });
});
