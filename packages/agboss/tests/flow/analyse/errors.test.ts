import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import {
  DraftKitWorkflowFinish,
  EditKitAgent,
  NotifyKitAction,
  SecondKitWorkflowStart,
} from "../fixtures/kit.fixture.js";
import { side, onStart, toAction, toFinish } from "../fixtures/paths.js";

/** `.onError(E, …)` right after the step that throws, one handler per class (#272 AC7). */

class CarrierError extends Error {}
class MailError extends Error {}

@Workflow({
  name: "two-handlers-workflow",
  version: "1.0.0",
  flow: [
    onStart(SecondKitWorkflowStart)
      .toAgent(EditKitAgent)
      .onError(CarrierError, toAction(NotifyKitAction).toFinish(DraftKitWorkflowFinish))
      .onError(MailError, toFinish(DraftKitWorkflowFinish))
      .toFinish(DraftKitWorkflowFinish),
  ],
})
class TwoHandlersWorkflow {}

@Workflow({
  name: "duplicate-handler-workflow",
  version: "1.0.0",
  flow: [
    onStart(SecondKitWorkflowStart)
      .toAgent(EditKitAgent)
      .onError(CarrierError, toAction(NotifyKitAction).toFinish(DraftKitWorkflowFinish))
      .onError(CarrierError, toFinish(DraftKitWorkflowFinish))
      .toFinish(DraftKitWorkflowFinish),
  ],
})
class DuplicateHandlerWorkflow {}

@Workflow({
  name: "empty-handler-workflow",
  version: "1.0.0",
  flow: [
    onStart(SecondKitWorkflowStart)
      .toAgent(EditKitAgent)
      .onError(CarrierError, side())
      .toFinish(DraftKitWorkflowFinish),
  ],
})
class EmptyHandlerWorkflow {}

describe("AC7: duplicate handler", () => {
  it("handlers for two classes on one step pass", () => {
    expect(checkWorkflow(TwoHandlersWorkflow).errors).toEqual([]);
  });

  it("two handlers for one class on one step fail", () => {
    expect(checkWorkflow(DuplicateHandlerWorkflow).errors).toEqual([
      expect.objectContaining({
        code: "flow.duplicate-error-handler",
        message:
          "duplicate-handler-workflow: edit-kit-agent has 2 handlers for CarrierError — one .onError(CarrierError, …) per class on a step",
      }),
    ]);
  });

  it("a side path that leads nowhere is a dead end", () => {
    expect(checkWorkflow(EmptyHandlerWorkflow).errors).toEqual([
      expect.objectContaining({
        code: "graph.dead-end",
        message:
          "empty-handler-workflow: edit-kit-agent: .onError(CarrierError, …) leads nowhere — start it with toAction(…) or toFinish(…)",
      }),
    ]);
  });
});
