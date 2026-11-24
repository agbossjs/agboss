/**
 * #1366: the direction of a cycle when its classes are linked by a join's error path and by an
 * `{ about }` edge — the producers of a cycle are its nodes and the branches of the launches it
 * can leave by `.onJoinError`; a write about a class it does not read still ties it into the cycle
 * it closes, so the one `{ about }` that directs the cycle is enough.
 */
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../../src/flow/analyse/analyse.js";
import { Action } from "../../../../src/flow/decorators/action.js";
import { Agent } from "../../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../../src/flow/decorators/workflow-start.js";
import { oneOf, optional } from "../../../../src/flow/dto-wrappers.js";
import { StepFailedError } from "../../../../src/graph/errors.js";
import { ArticleRequestDto, WorkflowStartTextDto } from "../../../flow/fixtures/dtos.js";
import { CriticAgent } from "../../../flow/fixtures/launch.fixture.js";
import { onAgent, caseOf, onStart, toAction } from "../../../flow/fixtures/paths.js";
import { ApprovalDto, CritiqueDto, DraftDto, PlanDto } from "../../../flow/fixtures/review-dtos.js";

const problemsOf = (workflow: object) =>
  checkWorkflow(workflow as never)
    .errors.filter((found) => found.code.startsWith("io.ambiguous"))
    .map(({ code, message, nodes }) => ({ code, message, nodes }));

class LeftDto {
  value!: string;
}

@Agent({
  name: "left-note-agent",
  description: "Notes the plan",
  prompt: "Note.",
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: LeftDto,
})
class LeftNoteAgent {}

describe("#1366: a cycle that only the join's error path closes", () => {
  it("the branches of a join whose happy path leaves the loop are not producers of the cycle", () => {
    @WorkflowStart({
      name: "retry-workflow-start",
      description: "Ask",
      input: WorkflowStartTextDto,
    })
    class RetryStart {}
    @WorkflowFinish({ name: "retry-workflow-finish", description: "Done", output: CritiqueDto })
    class RetryFinish {}
    @Agent({
      name: "retry-planner-agent",
      description: "Plans, or replans after a failed launch",
      prompt: "Plan.",
      model: "moonshotai/kimi-k2.6",
      maxVisits: 3,
      input: {
        message: WorkflowStartTextDto,
        critique: optional(CritiqueDto),
        note: optional(LeftDto),
      },
      output: PlanDto,
    })
    class RetryPlannerAgent {}
    @Action({
      name: "retry-note-action",
      description: "Notes the failure",
      input: { plan: PlanDto },
      output: LeftDto,
    })
    class RetryNoteAction {
      execute(): Promise<LeftDto> {
        return Promise.resolve({ value: "" });
      }
    }
    @Workflow({
      name: "retry-workflow",
      version: "1.0.0",
      flow: [
        onStart(RetryStart).returns(WorkflowStartTextDto).toAgent(RetryPlannerAgent),
        onAgent(RetryPlannerAgent)
          .returns(PlanDto)
          .toParallelAgents(LeftNoteAgent, CriticAgent)
          .join()
          .onJoinError(
            StepFailedError,
            toAction(RetryNoteAction).returns(LeftDto).toAgent(RetryPlannerAgent),
          )
          .returns(LeftDto)
          .returns(CritiqueDto)
          .toFinish(RetryFinish),
      ],
    })
    class RetryWorkflow {}

    const found = problemsOf(RetryWorkflow);

    expect(found.map((problem) => problem.code)).toStrictEqual(["io.ambiguous-cycle"]);
    expect(found[0]?.nodes).toStrictEqual(["retry-note-action", "retry-planner-agent"]);
  });
});

/** A writer ↔ reviewer loop (draft and notes built from each other); a plan built from the draft sits in it. */
const aboutLoop = (name: string): object => {
  @WorkflowStart({ name: `${name}-workflow-start`, description: "Ask", input: ArticleRequestDto })
  class AboutStart {}
  @WorkflowFinish({ name: `${name}-workflow-finish`, description: "Done", output: ApprovalDto })
  class AboutFinish {}
  @Agent({
    name: `${name}-writer-agent`,
    description: "Writes the draft, or rewrites it from the notes",
    prompt: "Write.",
    model: "moonshotai/kimi-k2.6",
    maxVisits: 3,
    input: { request: ArticleRequestDto, notes: optional(CritiqueDto) },
    output: DraftDto,
  })
  class AboutWriterAgent {}
  @Agent({
    name: `${name}-planner-agent`,
    description: "Plans from the draft",
    prompt: "Plan.",
    model: "moonshotai/kimi-k2.6",
    input: { draft: DraftDto },
    output: PlanDto,
  })
  class AboutPlannerAgent {}
  @Agent({
    name: `${name}-reviewer-agent`,
    description: "Approves the draft or writes notes",
    prompt: "Review.",
    model: "moonshotai/kimi-k2.6",
    maxVisits: 3,
    input: { draft: DraftDto },
    output: oneOf(ApprovalDto, CritiqueDto),
  })
  class AboutReviewerAgent {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      onStart(AboutStart).returns(ArticleRequestDto).toAgent(AboutWriterAgent),
      onAgent(AboutWriterAgent)
        .returns(DraftDto, { about: PlanDto })
        .toAgent(AboutPlannerAgent)
        .returns(PlanDto)
        .toAgent(AboutReviewerAgent)
        .returns(oneOf(ApprovalDto, CritiqueDto))
        .switch(
          caseOf(CritiqueDto).toAgent(AboutWriterAgent),
          caseOf(ApprovalDto).toFinish(AboutFinish),
        ),
    ],
  })
  class AboutLoopWorkflow {}
  return AboutLoopWorkflow;
};

describe("#1366: a write about a class it does not read", () => {
  it("still ties that class into the cycle it closes: the one { about } directs the cycle", () => {
    expect(problemsOf(aboutLoop("about"))).toStrictEqual([]);
  });
});
