import { StepError } from "../../../src/core/error-families/step-errors.js";
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import { GuardrailError } from "../../../src/core/error-families/limit-errors.js";
import { usd } from "../../../src/units/index.js";
import { describe, expect, it } from "vitest";
import { errorRecordOf } from "../../../src/index.js";
import { ExecutionCancelledError } from "../../../src/core/errors.js";
import { stepCoordinatesOf } from "../../../src/graph/step-coordinates.js";
import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { codeOfErrorClass, errorMatchOf } from "../../../src/core/error-record.js";
import { runInFrame } from "../../../src/flow/context/frame.js";
import { testExecutionContext, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { PayApplication, PayStart } from "./fixtures/pay.workflow.js";

/** #273 S22: an action's exception is `StepError.Action`, a `StepError` naming its step. */

const pay = testWith(PayApplication);

describe("S22: StepError.Action", () => {
  pay(
    "an action's own error fails its step: the step's coordinates, the original as cause",
    async ({ app }) => {
      const run = execute(app, PayStart, { id: "9", outcome: "crash" });

      await expect(run).rejects.toBeInstanceOf(StepError.Action);
      await expect(run).rejects.toBeInstanceOf(StepError);
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
      const result = await execute(
        app,
        PayStart,
        { id: "8", outcome: "fail" },
        { includeRecord: true },
      );

      expect(result.record?.lastError).toMatchObject({
        code: "step.action",
        lineage: ["step.action", "step", "agboss"],
        details: { component: { name: "charge-action" }, nodeId: "charge-action", visitNumber: 1 },
        cause: { code: "test.payment" },
      });
    },
  );
});

describe("S22: the StepError family", () => {
  it("agents, routers, actions and guards fail as StepError; limits do not", () => {
    const step = { nodeId: "main-router", visitNumber: 2 };

    expect(new StepError.Agent({ agent: "writer-agent", usage: [], cause: "boom" })).toBeInstanceOf(
      StepError,
    );
    expect(new StepError.Router({ ...step, cause: "boom" })).toBeInstanceOf(StepError);
    expect(new StepError.RouterDecision({ ...step, reason: "no route" })).toBeInstanceOf(StepError);
    expect(new StepError.Action({ action: "charge-action", cause: "boom" })).toBeInstanceOf(
      StepError,
    );
    expect(
      new StepError.Guardrail({ guardrail: "pii", usage: [], reason: "no answer" }),
    ).toBeInstanceOf(StepError);
    expect(
      new StepError.Agent({
        agent: "x",
        message: "x",
        usage: [],
        cause: undefined,
        ...stepCoordinatesOf("x", ComponentKind.Action),
      }),
    ).toBeInstanceOf(StepError);
    const limit = new LimitError.Agent({
      key: "maxSteps",
      limit: 1,
      actual: 2,
      path: [],
      spentUsd: usd(0),
    });
    expect(limit).not.toBeInstanceOf(StepError);
  });

  it("outside a step an error names its component at visit 0; inside, the step it runs in", async () => {
    const context = testExecutionContext({ step: { visitNumber: 3, itemIndex: 4 } });
    const step = { ...context.step, nodeId: "critic-agent#2" };
    const outside = new StepError.Agent({ agent: "critic-agent", usage: [], cause: "boom" });

    const { executionId, threadId, ownerId, signal, workflow, tenant } = context;
    const execution = { executionId, threadId, ownerId, signal, workflow, tenant, values: {} };
    const inside = await runInFrame({ execution, step }, () =>
      Promise.resolve(new StepError.Agent({ agent: "critic-agent", usage: [], cause: "boom" })),
    );

    expect(outside).toMatchObject({ nodeId: "critic-agent", visitNumber: 0 });
    expect(inside).toMatchObject({ nodeId: "critic-agent#2", visitNumber: 3, itemIndex: 4 });
  });

  it("StepError has its own code: .onError(StepError, …) takes exactly what Skip drops", () => {
    const step = { nodeId: "main-router", visitNumber: 1 };
    const errors: readonly Error[] = [
      new StepError.Agent({ agent: "writer-agent", usage: [], cause: "boom" }),
      new StepError.Router({ ...step, cause: "boom" }),
      new StepError.RouterDecision({ ...step, reason: "no route" }),
      new StepError.Action({ action: "charge-action", cause: "boom" }),
      new StepError.Guardrail({ guardrail: "pii", usage: [], reason: "no answer" }),
      new GuardrailError.Blocked({
        guardrail: "pii-guardrail",
        refusal: "no",
        usage: [],
        probability: 1,
        threshold: 0.5,
      }), // a StepError
      new StepError.Agent({ agent: "x", message: "paid", usage: [], cause: undefined }),
      new LimitError.Agent({
        key: "maxSteps",
        limit: 1,
        actual: 2,
        path: [],
        spentUsd: usd(0),
      }),
      new ExecutionCancelledError(),
      new Error("plain"),
    ];
    const code = codeOfErrorClass(StepError);

    const caught = errors.map((error) => errorMatchOf(errorRecordOf(error), code) !== undefined);
    const skipped = errors.map((error) => error instanceof StepError);

    expect(code).toBe("step");
    expect(caught).toEqual(skipped);
    expect(skipped).toEqual([true, true, true, true, true, false, true, false, false, false]);
  });
});
