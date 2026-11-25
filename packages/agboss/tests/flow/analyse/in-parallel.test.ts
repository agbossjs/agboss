import { StepError } from "../../../src/core/error-families/step-errors.js";
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { AGBossError } from "../../../src/core/errors.js";
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import {
  ItemsFailedAction,
  ItemsFailedWorkflowFinish,
  ItemsWorkflowStart,
  ProcessItemAction,
  SummaryAction,
} from "../runtime/fixtures/fan-out.workflow.js";
import { skip } from "../../../src/flow/builder.js";
import {
  ChooserRouter,
  ChooserWorkflow,
  ChooserWorkflowStart,
  ChosenAAction,
  ChosenBAction,
  ChosenSummaryAction,
  FirstAction,
  InParallelWorkflow,
  InParallelWorkflowStart,
  ModelChooserWorkflow,
  SecondAction,
  SecondDto,
  SummaryDto,
  SummaryWorkflowFinish,
  ThirdAgent,
} from "../runtime/fixtures/in-parallel.workflow.js";
import { onStart, toAction, toAgent, toRouter } from "../../helpers/flow.js";
import { Ttl } from "../../../src/index.js";

/** #1279: `.inParallel([…])`, `skip()` and `chooseMany([…])` in the analyser. */

@Action({
  name: "needs-second-action",
  description: "Needs the second branch's value, whole",
  input: { second: SecondDto },
  output: SummaryDto,
})
class NeedsSecondAction {
  execute(): SummaryDto {
    return { text: "x" };
  }
}

let count = 0;
const codesOf = (flow: WorkflowOptions["flow"]): readonly string[] => {
  count += 1;
  @Workflow({
    name: `in-parallel-case-${String(count)}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow,
  })
  class InParallelCaseWorkflow {}
  return checkWorkflow(InParallelCaseWorkflow).errors.map((found) => found.code);
};

describe("#1279: the assembly of a parallel launch", () => {
  it("a launch of mixed kinds, a skip() and a router's choice pass", () => {
    expect(checkWorkflow(InParallelWorkflow).errors).toEqual([]);
    expect(checkWorkflow(ChooserWorkflow).errors).toEqual([]);
    expect(checkWorkflow(ModelChooserWorkflow).errors).toEqual([]);
  });

  it("a skipped branch's value is optional: a step that needs it whole fails", () => {
    const codes = codesOf([
      onStart(InParallelWorkflowStart)
        .inParallel([
          toAction(FirstAction),
          toAction(SecondAction).onError(StepError, skip()),
          toAgent(ThirdAgent),
        ])
        .join()
        .toAction(NeedsSecondAction)
        .toFinish(SummaryWorkflowFinish),
    ]);
    expect(codes).toContain("input.missing-on-path");
  });

  it("a class listed twice with different skip() is [launch.skip-differs]", () => {
    expect(
      codesOf([
        onStart(InParallelWorkflowStart)
          .inParallel([toAction(SecondAction), toAction(SecondAction).onError(StepError, skip())])
          .join()
          .toFinish(SummaryWorkflowFinish),
      ]),
    ).toContain("launch.skip-differs");
  });

  it("a forEachItem after a step that gives no list is [launch.for-each-item-no-list]", () => {
    expect(
      codesOf([
        onStart(InParallelWorkflowStart)
          .forEachItem(toAction(FirstAction), { takeFirst: 2 })
          .join()
          .toFinish(SummaryWorkflowFinish),
      ]),
    ).toContain("launch.for-each-item-no-list");
  });

  it("chooseMany's branches are the router's routes: [router.routes-mismatch]", () => {
    expect(
      codesOf([
        onStart(ChooserWorkflowStart)
          .inParallel([
            toAction(FirstAction),
            toRouter(ChooserRouter).chooseMany([toAction(ChosenAAction)]),
          ])
          .join()
          .toAction(ChosenSummaryAction)
          .toFinish(SummaryWorkflowFinish),
      ]),
    ).toContain("router.routes-mismatch");
    expect(ChosenBAction.name).toBe("ChosenBAction");
  });

  it("a forEachItem with maxItems needs a handler for LimitError.Items, its parents or Error", () => {
    const withHandler = (error: new (...args: never[]) => Error) =>
      codesOf([
        onStart(ItemsWorkflowStart)
          .forEachItem(toAction(ProcessItemAction), { maxItems: 3 })
          .join()
          .onError(error, toAction(ItemsFailedAction).toFinish(ItemsFailedWorkflowFinish))
          .toAction(SummaryAction)
          .toFinish(SummaryWorkflowFinish),
      ]);
    expect(withHandler(LimitError.Items as never)).not.toContain(
      "launch.max-items-handler-required",
    );
    expect(withHandler(LimitError as never)).not.toContain("launch.max-items-handler-required");
    expect(withHandler(AGBossError as never)).not.toContain("launch.max-items-handler-required");
    expect(withHandler(StepError as never)).toContain("launch.max-items-handler-required");
    expect(
      codesOf([
        onStart(ItemsWorkflowStart)
          .forEachItem(toAction(ProcessItemAction), { maxItems: 3 })
          .join()
          .toAction(SummaryAction)
          .toFinish(SummaryWorkflowFinish),
      ]),
    ).toContain("launch.max-items-handler-required");
  });

  it("takeFirst needs no handler", () => {
    const codes = codesOf([
      onStart(ItemsWorkflowStart)
        .forEachItem(toAction(ProcessItemAction), { takeFirst: 3 })
        .join()
        .toAction(SummaryAction)
        .toFinish(SummaryWorkflowFinish),
    ]);
    expect(codes).not.toContain("launch.max-items-handler-required");
    expect(codes).not.toContain("launch.for-each-item-no-list");
  });
});
