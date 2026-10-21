import { describe, expect, it } from "vitest";
import { ExecutionContext } from "../../src/index.js";
import { testExecutionContext } from "../../src/testing/index.js";
import { NoteTool, WriterAgent } from "../flow/context/fixtures/context.workflow.js";
import { OfferWorkflow } from "../flow/fixtures/offer.fixture.js";

describe("#280: testExecutionContext — a frozen ExecutionContext for unit tests", () => {
  it("defaults: one root execution, its first step, readable with no execution running", () => {
    const context = testExecutionContext();

    expect(context).toBeInstanceOf(ExecutionContext);
    expect(context).toMatchObject({
      executionId: "test-execution",
      threadId: "test-execution",
      ownerId: undefined,
      itemIndex: undefined,
      depth: 1,
      parent: undefined,
      workflow: { name: "test-workflow", version: "0.0.0", startedVersion: "0.0.0" },
      step: {
        nodeId: "test-step",
        visitNumber: 1,
        copyNumber: 1,
        idempotencyKey: "test-execution:test-step:1",
      },
    });
    expect(context.root).toBe(context);
    expect(context.signal.aborted).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("names its workflow and step by their decorators; executionOf finds only its workflow", () => {
    const context = testExecutionContext({
      executionId: "exec-1",
      ownerId: "dana",
      workflow: OfferWorkflow,
      step: { component: WriterAgent, visitNumber: 2, itemIndex: 3, callId: "call_1" },
    });

    expect(context.workflow).toMatchObject({ type: OfferWorkflow, name: "offer-workflow" });
    expect(context.step).toMatchObject({
      component: { type: WriterAgent, name: "writer-agent" },
      idempotencyKey: "exec-1:writer-agent:2:3:call_1",
    });
    expect(context.executionOf(OfferWorkflow)).toBe(context);
    expect(context.executionOf(WriterAgent)).toBeUndefined();
  });

  it("a tool's step is named by its @Tool name; an undecorated class by its class name", () => {
    class PlainStep {
      readonly plain = true;
    }

    expect(testExecutionContext({ step: { component: NoteTool } }).step.nodeId).toBe("note-tool");
    expect(testExecutionContext({ step: { component: PlainStep } }).step.nodeId).toBe("PlainStep");
  });
});
