import { describe, expect, it } from "vitest";
import {
  currentFrame,
  inToolCallFrame,
  runInFrame,
  type FrameSpec,
} from "../../../src/flow/context/frame.js";
import { liveExecutionContextOf } from "../../../src/flow/context/live-context.js";
import { ExecutionContextUnavailableError } from "../../../src/index.js";
import { testExecutionContext } from "../../../src/testing/index.js";
import { WriterAgent } from "./fixtures/context.workflow.js";

/** The frame of the writer's first visit in execution `exec-1`. */
function writerFrame(): FrameSpec {
  const agent = testExecutionContext({ executionId: "exec-1", step: { component: WriterAgent } });
  const { executionId, threadId, ownerId, signal, workflow, tenant } = agent;
  return {
    execution: { executionId, threadId, ownerId, signal, workflow, tenant, values: {} },
    step: agent.step,
  };
}

const context = liveExecutionContextOf(undefined, "FrameTest");

describe("#280 S18: a frame per step, closed in finally", () => {
  it("outside any frame there is none", () => {
    expect(currentFrame()).toBeUndefined();
  });

  it("the work sees its frame; the frame closes when the work returns", async () => {
    let inside: ReturnType<typeof currentFrame>;

    await runInFrame(writerFrame(), () => {
      inside = currentFrame();
      return Promise.resolve();
    });

    expect(inside?.step.nodeId).toBe("writer-agent");
    expect(inside?.isClosed()).toBe(true);
    expect(currentFrame()).toBeUndefined();
  });

  it("the frame closes when the work throws too", async () => {
    let inside: ReturnType<typeof currentFrame>;

    const run = runInFrame(writerFrame(), () => {
      inside = currentFrame();
      return Promise.reject(new Error("boom"));
    });

    await expect(run).rejects.toThrow("boom");
    expect(inside?.isClosed()).toBe(true);
  });

  it("a tool call's frame: the call id set, closed while its agent's step goes on", async () => {
    await runInFrame(writerFrame(), async () => {
      const call = await inToolCallFrame("call_1", {}, () => Promise.resolve(currentFrame()));

      expect(call?.step).toMatchObject({
        callId: "call_1",
        idempotencyKey: "exec-1:writer-agent:1:call_1",
      });
      expect(call?.isClosed()).toBe(true);
      expect(context.step.callId).toBeUndefined();
    });
  });

  it("outside any step a tool call runs as it is (an agent loop on its own)", async () => {
    const frame = await inToolCallFrame("call_1", {}, () => Promise.resolve(currentFrame()));

    expect(frame).toBeUndefined();
  });

  it("a read through a closed frame names the ended step and its execution", async () => {
    let stray: Promise<unknown> = Promise.resolve();

    await runInFrame(writerFrame(), () => {
      // started inside the step, it reads once the step has ended
      stray = new Promise((resolve) => {
        setImmediate(() => {
          try {
            resolve(context.executionId);
          } catch (error) {
            resolve(error);
          }
        });
      });
      return Promise.resolve();
    });

    const read = await stray;
    expect(read).toBeInstanceOf(ExecutionContextUnavailableError);
    expect((read as Error).message).toContain(
      "the execution context was read after its step ended (writer-agent:1 in execution exec-1)",
    );
  });

  it("a read outside any frame names the consumer and the field", () => {
    expect(() => context.signal).toThrow(
      "FrameTest read executionContext.signal outside an execution",
    );
  });
});
