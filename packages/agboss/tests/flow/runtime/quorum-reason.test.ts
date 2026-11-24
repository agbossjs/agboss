/**
 * #1366: why a quorum was not reached is told by the clock against the ticket's deadline moved by the time its branches
 * waited in the tree's queue (#264): between the two ends the deadline has not passed, so the reason is the shortfall.
 */
import { describe, expect, it } from "vitest";
import { quorumNotReachedError } from "../../../src/flow/runtime/launch/quorum-join.js";
import { QuorumKind } from "../../../src/flow/ast.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";

/** A join of a count quorum whose ticket's deadline is 30 s after the clock's start, with `queued` ms in the queue. */
function reasonAt(
  advance: number,
  queued: number | undefined,
  quorum: object = { kind: QuorumKind.Count, min: 2 },
) {
  const clock = new VirtualClock();
  const site = {
    launch: { quorum, joinErrors: [] },
    ticket: {
      launchId: "run:vote:1",
      launcher: "vote",
      visitNumber: 1,
      branches: [],
      deadlineAt: clock.now().getTime() + 30_000,
    },
    records: [],
    state: { runId: "run" },
    config: { configurable: { clock } },
    deps: { components: new Map(), graph: { nodes: new Map() } },
    ...(queued === undefined ? {} : { queuedFor: queued }),
  };
  const decision = { outcome: { counted: [] } };
  return clock.advance(seconds(advance)).then(() => {
    return quorumNotReachedError(site as never, decision as never).message;
  });
}

describe("#1366: the reason a quorum was not reached", () => {
  it("with no time in the queue, the deadline has passed at the ticket's own deadline", async () => {
    expect(await reasonAt(30, undefined)).toMatch(/ — the deadline passed$/);
  });

  it("before the ticket's deadline it is the shortfall", async () => {
    expect(await reasonAt(29, undefined)).toMatch(/ — min can no longer be reached$/);
  });

  it("between the ticket's deadline and the deadline moved by the queue's time, it is still the shortfall", async () => {
    expect(await reasonAt(50, 40_000)).toMatch(/ — min can no longer be reached$/);
  });

  it("past the moved deadline it names it", async () => {
    expect(await reasonAt(70, 40_000)).toContain(
      "the deadline passed (2026-01-05T09:01:10.000Z: the ticket's deadline plus 40 s in the tree's queue)",
    );
  });

  it("a groups quorum that cannot complete says so", async () => {
    expect(await reasonAt(1, undefined, { kind: QuorumKind.Groups })).toMatch(
      / — no group can complete any more$/,
    );
  });
});
