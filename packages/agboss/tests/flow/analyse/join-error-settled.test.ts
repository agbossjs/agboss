import { StepError } from "../../../src/core/error-families/step-errors.js";
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { listOf, optional } from "../../../src/flow/dto-wrappers.js";
import { ScreeningFailedDto } from "../fixtures/launch-dtos.js";
import {
  ArticleDraftWorkflowFinish,
  ArticleWriterAgent,
  CriticAgent,
  PlannerAgent,
  PlanResearcherAgent,
  ResearchWorkflowStart,
  ScreeningFailedWorkflowFinish,
} from "../fixtures/launch.fixture.js";
import { CritiqueDto, ResearchDto } from "../fixtures/review-dtos.js";
import { onStart, toAction, toFinish, toAgent } from "../fixtures/paths.js";
import { Ttl } from "../../../src/index.js";

/**
 * #945 V3.6 — the settled answers on the error path: the `EdgeKind.JoinError` edge makes each branch
 * output of the launch available to the side path as an optional value (a list stays a list). They
 * are no join values: a side path reading none of them raises no `[flow.unused-output]`.
 */

type Flow = WorkflowOptions["flow"];

@Action({
  name: "settled-optional-action",
  description: "Reads the research if its branch answered",
  input: { research: optional(ResearchDto), critiques: listOf(CritiqueDto) },
  output: ScreeningFailedDto,
})
class SettledOptionalAction {
  // analysed only, never run: no generated types, so the handler is typed by hand
  execute(_input: unknown): Promise<never> {
    return Promise.reject(new Error("not run"));
  }
}

@Action({
  name: "settled-required-action",
  description: "Reads the research as if it always came",
  input: { research: ResearchDto },
  output: ScreeningFailedDto,
})
class SettledRequiredAction {
  execute(_input: unknown): Promise<never> {
    return Promise.reject(new Error("not run"));
  }
}

let count = 0;
function codesOf(sidePath: ReturnType<typeof toAction>): readonly string[] {
  count += 1;
  const flow: Flow = [
    onStart(ResearchWorkflowStart)
      .toAgent(PlannerAgent)
      .inParallel([toAgent(PlanResearcherAgent), toAgent(CriticAgent), toAgent(CriticAgent)], {
        maxConcurrency: 3,
      })
      .join()
      .onError(StepError.PauseExpired, sidePath)
      .toAgent(ArticleWriterAgent)
      .toFinish(ArticleDraftWorkflowFinish),
  ];
  @Workflow({
    name: `settled-${String(count)}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow,
  })
  class SettledWorkflow {}
  return checkWorkflow(SettledWorkflow).errors.map((found) => found.code);
}

describe("V3.6: the settled answers on the error path", () => {
  it("a side path reads a branch output as optional, a list as a list", () => {
    const side = toAction(SettledOptionalAction).toFinish(ScreeningFailedWorkflowFinish);

    expect(codesOf(side)).toEqual([]);
  });

  it("a side path reading a branch output non-optionally is an assembly error", () => {
    const side = toAction(SettledRequiredAction).toFinish(ScreeningFailedWorkflowFinish);

    expect(codesOf(side)).toContain("input.missing-on-path");
  });

  it(".onError(StepError.PauseExpired, toFinish(F)) reading none of them: no [flow.unused-output]", () => {
    expect(codesOf(toFinish(ArticleDraftWorkflowFinish))).not.toContain("flow.unused-output");
  });
});
