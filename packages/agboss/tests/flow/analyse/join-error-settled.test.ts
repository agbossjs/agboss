import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { listOf, optional } from "../../../src/flow/dto-wrappers.js";
import { PauseExpiredError } from "../../../src/flow/runtime/pause-expired-error.js";
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
import { WorkflowStartTextDto } from "../fixtures/dtos.js";
import { ArticleDraftDto } from "../fixtures/launch-dtos.js";
import { CritiqueDto, PlanDto, ResearchDto } from "../fixtures/review-dtos.js";
import { start, toAction, toFinish } from "../fixtures/paths.js";

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
    start(ResearchWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(PlannerAgent)
      .returns(PlanDto)
      .toParallelAgents(PlanResearcherAgent, CriticAgent, CriticAgent, { maxConcurrency: 3 })
      .join()
      .onJoinError(PauseExpiredError, sidePath)
      .returns(ResearchDto)
      .returns(listOf(CritiqueDto))
      .toAgent(ArticleWriterAgent)
      .returns(ArticleDraftDto)
      .toFinish(ArticleDraftWorkflowFinish),
  ];
  @Workflow({ name: `settled-${String(count)}-workflow`, version: "1.0.0", flow })
  class SettledWorkflow {}
  return checkWorkflow(SettledWorkflow).errors.map((found) => found.code);
}

describe("V3.6: the settled answers on the error path", () => {
  it("a side path reads a branch output as optional, a list as a list", () => {
    const side = toAction(SettledOptionalAction)
      .returns(ScreeningFailedDto)
      .toFinish(ScreeningFailedWorkflowFinish);

    expect(codesOf(side)).toEqual([]);
  });

  it("a side path reading a branch output non-optionally is an assembly error", () => {
    const side = toAction(SettledRequiredAction)
      .returns(ScreeningFailedDto)
      .toFinish(ScreeningFailedWorkflowFinish);

    expect(codesOf(side)).toContain("input.missing-on-path");
  });

  it(".onJoinError(PauseExpiredError, toFinish(F)) reading none of them: no [flow.unused-output]", () => {
    expect(codesOf(toFinish(ArticleDraftWorkflowFinish))).not.toContain("flow.unused-output");
  });
});
