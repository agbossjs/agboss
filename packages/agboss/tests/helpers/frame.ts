import { runInFrame, type FrameSpec } from "../../src/flow/context/frame.js";
import { testExecutionContext } from "../../src/testing/execution-context.js";

/**
 * A step's frame for a unit of the agent loop run on its own (#261): node events are reported only
 * inside a step, so a unit test that checks them runs its node in one.
 */
export function testFrame(): FrameSpec {
  const context = testExecutionContext();
  return {
    execution: {
      executionId: context.executionId,
      threadId: context.threadId,
      ownerId: context.ownerId,
      signal: context.signal,
      workflow: context.workflow,
      tenant: context.tenant,
      values: {},
    },
    step: context.step,
  };
}

/** Runs `work` inside a test step's frame. */
export const inTestFrame = <TResult>(work: () => Promise<TResult>): Promise<TResult> =>
  runInFrame(testFrame(), work);
