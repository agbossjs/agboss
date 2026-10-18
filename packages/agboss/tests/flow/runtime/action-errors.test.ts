import { describe, expect, it } from "vitest";
import {
  ActionFailedError,
  AgentFailedError,
  errorRecordOf,
  GuardFailedError,
  GuardrailBlockedError,
  LimitExceededError,
  PaidStepError,
  RouterDecisionError,
  RouterFailedError,
  StepFailedError,
  WorkflowCancelledError,
} from "../../../src/index.js";
import { stepCoordinatesOf } from "../../../src/graph/errors.js";
import { codeOfErrorClass, errorMatchOf } from "../../../src/core/error-record.js";
import { runInFrame } from "../../../src/flow/context/frame.js";
import { testExecutionContext, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { PayApplication, PayStart } from "./fixtures/pay.workflow.js";

/** #273 S22: an action's exception is `ActionFailedError`, a `StepFailedError` naming its step. */

const pay = testWith(PayApplication);

describe("S22: ActionFailedError", () => {
  pay(
    "an action's own error fails its step: the step's coordinates, the original as cause",
    async ({ app }) => {
      const run = execute(app, PayStart, { id: "9", outcome: "crash" });

      await expect(run).rejects.toBeInstanceOf(ActionFailedError);
      await expect(run).rejects.toBeInstanceOf(StepFailedError);
      await expect(run).rejects.toMatchObject({
        code: "step.action",
        component: { name: "charge-action" },
        nodeId: "charge-action",
        visitNumber: 1,
        itemIndex: undefined,
        cause: { message: "the ledger is down" },
      });
    },
  );

  pay(
    "the record names the step, so .onError matches either the wrapper or the cause",
    async ({ app }) => {
      const result = await execute(app, PayStart, { id: "8", outcome: "fail" }, { record: true });

      expect(result.record?.lastError).toMatchObject({
        code: "step.action",
        lineage: ["step.action", "step.failed", "step", "agboss"],
        details: { component: { name: "charge-action" }, nodeId: "charge-action", visitNumber: 1 },
        cause: { code: "test.payment" },
      });
    },
  );
});

describe("S22: the StepFailedError family", () => {
  it("agents, routers, actions and guards fail as StepFailedError; limits do not", () => {
    const step = { nodeId: "main-router", visitNumber: 2 };

    expect(new AgentFailedError("writer-agent", [], "boom")).toBeInstanceOf(StepFailedError);
    expect(new RouterFailedError(step, "boom")).toBeInstanceOf(StepFailedError);
    expect(new RouterDecisionError(step, "no route")).toBeInstanceOf(StepFailedError);
    expect(new ActionFailedError("charge-action", "boom")).toBeInstanceOf(StepFailedError);
    expect(new GuardFailedError("pii", [], "no answer")).toBeInstanceOf(StepFailedError);
    expect(new StepFailedError("x", [], undefined, stepCoordinatesOf("x"))).toBeInstanceOf(
      PaidStepError,
    );
    const limit = new LimitExceededError({ key: "maxSteps", limit: 1, actual: 2 }, [], 0);
    expect(limit).not.toBeInstanceOf(StepFailedError);
  });

  it("outside a step an error names its component at visit 0; inside, the step it runs in", async () => {
    const context = testExecutionContext({ step: { visitNumber: 3, itemIndex: 4 } });
    const step = { ...context.step, nodeId: "critic-agent#2" };
    const outside = new AgentFailedError("critic-agent", [], "boom");

    const inside = await runInFrame({ execution: { ...context, values: {} }, step }, () =>
      Promise.resolve(new AgentFailedError("critic-agent", [], "boom")),
    );

    expect(outside).toMatchObject({ nodeId: "critic-agent", visitNumber: 0 });
    expect(inside).toMatchObject({ nodeId: "critic-agent#2", visitNumber: 3, itemIndex: 4 });
  });

  it("StepFailedError has its own code: .onJoinError(StepFailedError, …) takes exactly what Skip drops", () => {
    const step = { nodeId: "main-router", visitNumber: 1 };
    const errors: readonly Error[] = [
      new AgentFailedError("writer-agent", [], "boom"),
      new RouterFailedError(step, "boom"),
      new RouterDecisionError(step, "no route"),
      new ActionFailedError("charge-action", "boom"),
      new GuardFailedError("pii", [], "no answer"),
      new GuardrailBlockedError("pii", "no", []), // a PaidStepError, not a StepFailedError
      new PaidStepError("paid", [], undefined),
      new LimitExceededError({ key: "maxSteps", limit: 1, actual: 2 }, [], 0),
      new WorkflowCancelledError(),
      new Error("plain"),
    ];
    const code = codeOfErrorClass(StepFailedError);

    const caught = errors.map((error) => errorMatchOf(errorRecordOf(error), code) !== undefined);
    const skipped = errors.map((error) => error instanceof StepFailedError);

    expect(code).toBe("step.failed");
    expect(caught).toEqual(skipped);
    expect(skipped).toEqual([true, true, true, true, true, false, false, false, false, false]);
  });
});
