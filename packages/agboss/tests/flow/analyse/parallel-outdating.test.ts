import { describe, expect, it } from "vitest";
import { Text } from "../../../src/dto/index.js";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { listOf } from "../../../src/flow/dto-wrappers.js";
import { CompanyDto } from "../fixtures/data-dtos.js";
import { WorkflowStartTextDto } from "../fixtures/dtos.js";
import { ArticleDraftDto } from "../fixtures/launch-dtos.js";
import { PlannerAgent, ResearchWorkflowStart } from "../fixtures/launch.fixture.js";
import { start } from "../fixtures/paths.js";
import type { PathSource } from "../../../src/flow/ast.js";
import type { PathBuilder } from "../../../src/flow/path-builder.js";
import { CritiqueDto, PlanDto, ResearchDto } from "../fixtures/review-dtos.js";

/**
 * #271 AC9 (rule 10, S13), built by #273 PR 1: a parallel branch sees the scope at the launch, and a
 * branch returning a class another branch of the same launch was built from is
 * `[launch.branch-outdates-sibling]` at the join — whether anything reads the outdated value or not.
 */

class BriefDto {
  @Text({ prompt: "the brief built from the plan" })
  brief!: string;
}

class OutlineDto {
  @Text({ prompt: "an outline of the plan" })
  outline!: string;
}

@Agent({
  name: "replanner-agent",
  description: "Writes a new plan",
  prompt: "Replan.",
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: PlanDto,
})
class ReplannerAgent {}

@Agent({
  name: "plan-reader-agent",
  description: "Researches the plan",
  prompt: "Research.",
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: ResearchDto,
})
class PlanReaderAgent {}

@Agent({
  name: "brief-agent",
  description: "Writes a brief from the plan",
  prompt: "Brief.",
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: BriefDto,
})
class BriefAgent {}

@Agent({
  name: "brief-reader-agent",
  description: "Outlines the brief",
  prompt: "Outline.",
  model: "moonshotai/kimi-k2.6",
  input: { brief: BriefDto },
  output: OutlineDto,
})
class BriefReaderAgent {}

@Agent({
  name: "critique-agent",
  description: "Criticises the plan",
  prompt: "Criticise.",
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: CritiqueDto,
})
class CritiqueAgent {}

@Agent({
  name: "company-planner-agent",
  description: "Plans per company",
  prompt: "Plan the company.",
  model: "moonshotai/kimi-k2.6",
  input: { company: CompanyDto, plan: PlanDto },
  output: PlanDto,
})
class CompanyPlannerAgent {}

@Agent({
  name: "companies-agent",
  description: "Lists companies for the plan",
  prompt: "List.",
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: listOf(CompanyDto),
})
class CompaniesAgent {}

@Action({
  name: "replan-action",
  description: "Writes a new plan",
  input: { plan: PlanDto },
  output: PlanDto,
})
class ReplanAction {
  execute(): Promise<PlanDto> {
    return Promise.resolve({ outline: "again" });
  }
}

@Action({
  name: "research-action",
  description: "Researches the plan",
  input: { plan: PlanDto },
  output: ResearchDto,
})
class ResearchAction {
  execute(): Promise<ResearchDto> {
    return Promise.resolve({ facts: "found" });
  }
}

@Agent({
  name: "summary-agent",
  description: "Sums everything up",
  prompt: "Sum up.",
  model: "moonshotai/kimi-k2.6",
  output: ArticleDraftDto,
})
class SummaryAgent {}

@WorkflowFinish({
  name: "summary-workflow-finish",
  description: "The summary",
  output: ArticleDraftDto,
})
class SummaryWorkflowFinish {}

let count = 0;
function errorsOf(flow: WorkflowOptions["flow"]): readonly { code: string; message: string }[] {
  count += 1;
  @Workflow({ name: `outdating-case-${String(count)}-workflow`, version: "1.0.0", flow })
  class OutdatingCaseWorkflow {}
  return checkWorkflow(OutdatingCaseWorkflow).errors.map(({ code, message }) => ({
    code,
    message,
  }));
}

const planned = () =>
  start(ResearchWorkflowStart).returns(WorkflowStartTextDto).toAgent(PlannerAgent).returns(PlanDto);

/** Every value of the join read by an agent without input (it reads the whole scope). */
const summed = (path: PathBuilder<PathSource>): PathBuilder<PathSource> =>
  path.toAgent(SummaryAgent).returns(ArticleDraftDto).toFinish(SummaryWorkflowFinish);

describe("#271 AC9: branch outdates sibling — every join kind", () => {
  it("agents: a branch renewing what a sibling read, named with the launch", () => {
    const flow = [
      summed(
        planned()
          .toParallelAgents(PlanReaderAgent, ReplannerAgent)
          .join()
          .returns(PlanDto)
          .returns(ResearchDto),
      ),
    ];
    expect(errorsOf(flow)).toContainEqual({
      code: "launch.branch-outdates-sibling",
      message: `outdating-case-${String(count)}-workflow: replanner-agent returns PlanDto, which plan-reader-agent of the same launch was built from: plan-reader-agent's ResearchDto is outdated at the join of planner-agent → toParallelAgents(plan-reader-agent, replanner-agent)`,
    });
  });

  it("actions: the same rule at the join of parallel actions", () => {
    const flow = [
      summed(
        planned()
          .toParallelActions(ResearchAction, ReplanAction)
          .join()
          .returns(PlanDto)
          .returns(ResearchDto),
      ),
    ];
    expect(errorsOf(flow).map((found) => found.code)).toContain("launch.branch-outdates-sibling");
  });

  it("through what the read value was built from: a brief built from the plan", () => {
    const flow = [
      summed(
        planned()
          .toAgent(BriefAgent)
          .returns(BriefDto)
          .toParallelAgents(BriefReaderAgent, ReplannerAgent)
          .join()
          .returns(OutlineDto)
          .returns(PlanDto),
      ),
    ];
    expect(errorsOf(flow)).toContainEqual(
      expect.objectContaining({
        code: "launch.branch-outdates-sibling",
        message: expect.stringContaining(
          "brief-reader-agent's OutlineDto is outdated at the join of brief-agent",
        ),
      }),
    );
  });

  it("siblings that read nothing another renews pass", () => {
    const flow = [
      summed(
        planned()
          .toParallelAgents(PlanReaderAgent, CritiqueAgent)
          .join()
          .returns(CritiqueDto)
          .returns(ResearchDto),
      ),
    ];
    expect(errorsOf(flow).map((found) => found.code)).not.toContain(
      "launch.branch-outdates-sibling",
    );
  });
});

describe("#271 AC9: per-item never triggers", () => {
  it("a per-item run renewing what it read writes one list slot", () => {
    const flow = [
      summed(
        planned()
          .toAgent(CompaniesAgent)
          .returns(listOf(CompanyDto))
          .toParallelAgents(CompanyPlannerAgent, { maxItems: 5 })
          .join()
          .returns(listOf(PlanDto)),
      ),
    ];
    expect(errorsOf(flow).map((found) => found.code)).not.toContain(
      "launch.branch-outdates-sibling",
    );
  });

  it("copies of one agent never outdate each other", () => {
    const flow = [
      summed(
        planned().toParallelAgents(ReplannerAgent, ReplannerAgent).join().returns(listOf(PlanDto)),
      ),
    ];
    expect(errorsOf(flow).map((found) => found.code)).not.toContain(
      "launch.branch-outdates-sibling",
    );
  });
});
