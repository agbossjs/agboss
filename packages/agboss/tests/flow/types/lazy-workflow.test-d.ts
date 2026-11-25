import { StepError } from "../../../src/core/error-families/step-errors.js";
import { describe, expectTypeOf, it } from "vitest";
import type { Class } from "../../../src/components/injection.js";
import { onStart, onWorkflow, toAction, toWorkflow, toFinish } from "../../../src/flow/builder.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import type { InputOf } from "../../../src/flow/generated-types.js";
import type { ClassOf } from "../../../src/flow/target-ref.js";
import * as flowEntry from "../../../src/public/flow.js";
import {
  MarkUnitFailedAction,
  OrgChartFailedDto,
  OrgChartFailedWorkflowFinish,
  OrgChartWorkflow,
  OrgDrillWorkflow,
  OrgRetryWorkflow,
  OrgRetryWorkflowStart,
  OrgUnitDto,
  TeamChartDto,
  TeamChartWorkflowFinish,
  UnitCharterAgent,
} from "../fixtures/org-chart.fixture.js";

/**
 * #1287 — `toWorkflow(() => W)` and `onWorkflow(() => W)` carry the real `typeof W`, so a workflow
 * names its own class inside its own `@Workflow({ flow })` without TS2506 / TS7022 (the fixtures
 * compile); `@Workflow` returns nothing; `ThisWorkflow` and its claims are gone.
 */

describe("#1287: a thunk is a workflow target", () => {
  it("ClassOf is the class of a class and of its thunk", () => {
    expectTypeOf<ClassOf<typeof OrgChartWorkflow>>().toEqualTypeOf<typeof OrgChartWorkflow>();
    expectTypeOf<ClassOf<() => typeof OrgChartWorkflow>>().toEqualTypeOf<typeof OrgChartWorkflow>();
  });

  it("a workflow's own class is named by a thunk in its own flow, the same forms as a class", () => {
    const retry = onStart(OrgRetryWorkflowStart)
      .toAgent(UnitCharterAgent)
      .onError(
        StepError,
        toWorkflow(() => OrgRetryWorkflow).toOneOf([
          toFinish(TeamChartWorkflowFinish),
          toFinish(OrgChartFailedWorkflowFinish),
        ]),
      )
      .toFinish(TeamChartWorkflowFinish);
    const outcomes = [
      toFinish(TeamChartWorkflowFinish),
      toFinish(OrgChartFailedWorkflowFinish),
    ] as const;
    onWorkflow(() => OrgDrillWorkflow).toOneOf(outcomes);
    onWorkflow(OrgDrillWorkflow).toOneOf(outcomes);

    expectTypeOf(retry).toHaveProperty("steps");
  });

  it("a thunk of anything but a workflow is refused, as the class is", () => {
    // @ts-expect-error — a thunk of an agent is no child workflow
    onStart(OrgRetryWorkflowStart).toWorkflow(() => UnitCharterAgent);
    // @ts-expect-error — nor is the agent itself
    onStart(OrgRetryWorkflowStart).toWorkflow(UnitCharterAgent);
    // @ts-expect-error — a thunk of an action is no child workflow either
    toWorkflow(() => MarkUnitFailedAction);
    // @ts-expect-error — a function that gives no class is no target
    toAction(() => 1);
  });
});

describe("#1287: the decorator", () => {
  it("@Workflow returns nothing, so a class's type never depends on its own flow", () => {
    expectTypeOf<ReturnType<ReturnType<typeof Workflow>>>().toBeVoid();
    expectTypeOf<ReturnType<typeof Workflow>>().toEqualTypeOf<(value: Class) => void>();
  });
});

describe("#1287: Inputs[workflow]", () => {
  it("is the start's input, for a workflow that launches itself too", () => {
    expectTypeOf<InputOf<OrgChartWorkflow>>().toEqualTypeOf<OrgUnitDto>();
    expectTypeOf<InputOf<OrgDrillWorkflow>>().toEqualTypeOf<OrgUnitDto>();
  });
});

describe("#1287: ThisWorkflow is removed", () => {
  it("the flow entry exports neither the marker nor its table", () => {
    expectTypeOf<keyof typeof flowEntry>().not.toExtend<"ThisWorkflow">();
    expectTypeOf(flowEntry).not.toHaveProperty("ThisWorkflow");
  });
});
