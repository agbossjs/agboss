/**
 * #1366: what a resting root's record states when a pause is answered — the root goes `running` again with the
 * route and the spend the run had, so a root that is `running` between the mark and its recovery still shows what it
 * cost; a pause past its deadline is refused before the mark, and the check of it is at the deadline itself.
 */
import { describe, expect, it } from "vitest";
import { markAnswered } from "../../src/app/paused-runs.js";
import { PauseStatus } from "../../src/infrastructure/pause-record.js";

function parts(pause: object) {
  const completed: unknown[] = [];
  return {
    completed,
    parts: {
      pauses: { findByTenantIdAndPauseId: () => Promise.resolve(pause) },
      paused: { find: () => Promise.resolve(undefined) },
      turns: {
        completeIfStatus: (id: string, status: string, outcome: unknown) => {
          completed.push([id, status, outcome]);
          return Promise.resolve(true);
        },
      },
      log: { warn: () => undefined },
      clock: { now: () => new Date("2026-01-01T00:05:00.000Z") },
    } as never,
  };
}

const pending = { tenantId: "t", pauseId: "p", threadId: "th", status: PauseStatus.Pending };
const rested = { runId: "r", turnId: "turn-1", path: ["start", "agent"], cost: { totalUsd: 0.75 } };

describe("#1366: the record of a root whose pause is answered", () => {
  it("goes running with the run's route and its whole spend", async () => {
    const { parts: given, completed } = parts(pending);

    const isMarked = await markAnswered(given, pending as never, rested as never);

    expect(isMarked).toBe(true);
    expect(completed).toMatchObject([
      ["turn-1", "paused", { costUsd: 0.75, route: ["start", "agent"] }],
    ]);
  });

  it("is not marked without a resting run", async () => {
    const { parts: given, completed } = parts(pending);

    expect(await markAnswered(given, pending as never, undefined)).toBe(false);
    expect(completed).toEqual([]);
  });

  it("a pause whose deadline is the instant of the call is refused before the mark, one a millisecond later is not", async () => {
    const now = new Date("2026-01-01T00:05:00.000Z");
    const due = { ...pending, expiresAt: now.toISOString() };
    const open = { ...pending, expiresAt: new Date(now.getTime() + 1).toISOString() };
    const refused = parts(due);
    const allowed = parts(open);

    const error = await markAnswered(refused.parts, due as never, rested as never).catch(
      (caught: unknown) => caught,
    );
    const marked = await markAnswered(allowed.parts, open as never, rested as never);

    expect(error).toBeInstanceOf(Error);
    expect(refused.completed).toEqual([]);
    expect(marked).toBe(true);
  });
});
