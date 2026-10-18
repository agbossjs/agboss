import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runInFrame, type FrameSpec } from "../../../src/flow/context/frame.js";
import { LiveExecutionContext } from "../../../src/flow/context/live-context.js";
import { defineTool } from "../../../src/tools/index.js";
import { replyWith, routeTo, testExecutionContext, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  callTools,
  harness,
  replyWith as loopReply,
  runLoop,
  startInput,
} from "../../graph/agent-loop/fixtures.js";
import {
  ContextStart,
  DraftDto,
  PublishAction,
  ReviewRouter,
  WriterAgent,
  resetSeen,
  seen,
  ContextApplication,
} from "./fixtures/context.workflow.js";

const context = new LiveExecutionContext("ParallelTest");

/** A tool that reads its step after `delayMs`, while the other call runs. */
const reader = (name: string, delayMs: number, steps: Map<string, unknown>) =>
  defineTool({
    name,
    description: `reads its step after ${String(delayMs)} ms`,
    input: z.object({}),
    output: z.string(),
    run: async () => {
      const before = context.step.callId;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      steps.set(name, { before, after: context.step.callId, key: context.step.idempotencyKey });
      return name;
    },
  });

function agentFrame(): FrameSpec {
  const agent = testExecutionContext({ executionId: "exec-1", step: { component: WriterAgent } });
  const { executionId, threadId, ownerId, signal, workflow } = agent;
  return { execution: { executionId, threadId, ownerId, signal, workflow }, step: agent.step };
}

describe("#280 AC7: parallel branches each see their own step", () => {
  it("two tool calls of one model turn, overlapping: each reads its own call id", async () => {
    const steps = new Map<string, unknown>();
    const { graph } = harness({
      moves: [
        callTools(
          { id: "slow", name: "slow_read", args: {} },
          { id: "fast", name: "fast_read", args: {} },
        ),
        loopReply("both read"),
      ],
      tools: () => [reader("slow_read", 30, steps), reader("fast_read", 1, steps)],
      approval: false,
    });

    await runInFrame(agentFrame(), () => runLoop(graph, startInput(), "thread-1"));

    expect(steps.get("slow_read")).toEqual({
      before: "slow",
      after: "slow",
      key: "exec-1:writer-agent:1:slow",
    });
    expect(steps.get("fast_read")).toEqual({
      before: "fast",
      after: "fast",
      key: "exec-1:writer-agent:1:fast",
    });
  });

  const test = testWith(ContextApplication);

  test("two executions at once: each component reads its own execution", async ({
    app,
    mockLlm,
  }) => {
    resetSeen();
    mockLlm(WriterAgent).thenReturnAlways(replyWith(DraftDto, { text: "a draft" }));
    mockLlm(ReviewRouter).thenReturnAlways(routeTo(PublishAction));

    const [first, second] = await Promise.all([
      execute(app, ContextStart, { text: "one" }),
      execute(app, ContextStart, { text: "two" }),
    ]);

    expect(seen.actionSteps.map((step) => step.idempotencyKey).sort()).toEqual(
      [`${first.runId}:publish-action:1`, `${second.runId}:publish-action:1`].sort(),
    );
  });
});
