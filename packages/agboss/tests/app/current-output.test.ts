/**
 * #801: a resume whose decision another holder took answers with the stored run's pauses still
 * pending — each as its record says now (its kind, its step, its ask), so a run stored before 0.1.1,
 * whose `pending` names `agent`, reads like any other.
 */
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { RandomIdGenerator } from "../../src/infrastructure/clock.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { stillPending } from "../../src/app/current-output.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import type { PauseSeam, WaitingPause } from "../../src/pause/types.js";
import {
  pausedRunOf,
  pauseOf,
  questionPauseOf,
} from "../../src/testing/contracts/paused-execution-data.js";
import { PauseKind } from "../../src/infrastructure/pause-kind.js";

/** A stored run's `pending` as 0.1.0 wrote it: `agent`, no `kind`, no `step`. */
const listedBefore = (pauseId: string, agent: string): WaitingPause =>
  ({
    pauseId,
    agent,
    answeredBy: "channel",
    channel: "refund-approval-channel",
    childExecutionId: undefined,
    itemIndex: undefined,
    ask: {},
  }) as unknown as WaitingPause;

describe("#801: the pauses still pending, as their records say", () => {
  it("a run stored before 0.1.1 lists each pending pause with its kind and step; an answered one is gone", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    await pauses.findOrCreateByStepKey(pauseOf("p-approval"));
    await pauses.findOrCreateByStepKey(questionPauseOf("p-question"));
    await pauses.findOrCreateByStepKey(pauseOf("p-answered", "run-1:clerk-agent:1:call-2"));
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-answered",
      { decision: { approved: true }, answerer: "manager-17" },
      new Date(0),
    );
    const stored = {
      ...pausedRunOf("thread-1").run,
      pending: [
        listedBefore("p-approval", "clerk-agent"),
        listedBefore("p-question", "spending-limit-question"),
        listedBefore("p-answered", "clerk-agent"),
      ],
    };

    const seam: PauseSeam = {
      checkpointer: new MemorySaver(),
      pauses,
      answers: new InMemoryExecutionRecordRepository(new VirtualClock(), new RandomIdGenerator()),
    };
    const now = await stillPending({ pause: seam }, stored);

    expect(now.pending).toEqual([
      expect.objectContaining({
        pauseId: "p-approval",
        kind: PauseKind.Approval,
        step: "clerk-agent",
      }),
      expect.objectContaining({
        pauseId: "p-question",
        kind: PauseKind.Question,
        step: "spending-limit-question",
        ask: { item: "laptop", priceUsd: 1200, nested: { tags: ["it", "q4"] } },
      }),
    ]);
  });
});
