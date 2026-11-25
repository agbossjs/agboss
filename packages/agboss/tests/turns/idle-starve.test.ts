import { describe, expect, it } from "vitest";
import { hours, usd } from "../../src/units/index.js";
import { createSqliteTurnStore, type NewTurn } from "../../src/turns/index.js";

const WORKFLOW = "desk-workflow";
const turn = (threadId: string, runId: string): NewTurn => ({
  runId,
  threadId,
  tenantId: "default",
  workflow: WORKFLOW,
  task: "t",
  replyWith: "r",
  status: "answered",
  stopReason: "",
  route: [],
  steps: [],
  costUsd: usd(0.01),
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: null,
  configHash: null,
});

describe("idle-thread sweep does not starve", () => {
  it("100 idle threads whose runs are not ended do not block a later idle, ended thread", async () => {
    let at = new Date("2026-01-05T09:00:00.000Z");
    const store = createSqliteTurnStore(":memory:", () => at);
    const live = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const thread = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
      await store.append(turn(thread, `paused-${String(i)}`));
      live.add(`paused-${String(i)}`);
    }
    at = new Date(at.getTime() + 60_000);
    const victim = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
    await store.append(turn(victim, "ended-run"));
    at = new Date(at.getTime() + hours(48));
    const isEnded = ({ rootExecutionId }: { rootExecutionId: string }) =>
      Promise.resolve(!live.has(rootExecutionId));
    const cutoffs = new Map([[WORKFLOW, new Date(at.getTime() - hours(1))]]);
    let removed = 0;
    for (let look = 0; look < 5; look += 1)
      removed += await store.deleteIdleThreads(cutoffs, isEnded);
    expect(removed).toBe(1);
    // the kept ones are kept: a later look still pages past them, and still removes nothing of them
    expect(await store.deleteIdleThreads(cutoffs, isEnded)).toBe(0);
  });
});
