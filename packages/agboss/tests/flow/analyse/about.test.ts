import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { statesOf } from "../../../src/flow/analyse/dataflow.js";
import { slotOf, SlotStatus, type SlotKey } from "../../../src/flow/analyse/scope.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import type { DtoClass } from "../../../src/dto/types.js";
import type { ReturnsOptions } from "../../../src/flow/builder-types.js";
import type { InputFieldShape } from "../../../src/flow/decorators/declaration.js";
import { historyOf, oneOf, optional } from "../../../src/flow/dto-wrappers.js";
import type { ComponentName } from "../../../src/flow/registry.js";
import { DraftChangesDto } from "../fixtures/data-dtos.js";
import { ArticleDto, ArticleRequestDto } from "../fixtures/dtos.js";
import { agent, caseOf, route, start } from "../fixtures/paths.js";
import { ApprovalDto, CritiqueDto, DraftDto, PlanDto } from "../fixtures/review-dtos.js";
import {
  PolishWorkflow,
  StoryWorkflow,
  StoryWorkflowFinish,
  StoryWorkflowStart,
} from "../fixtures/review.fixture.js";

/**
 * #271 rule 5 (AC4): the direction of a cycle is written with `{ about }` in the flow — on a
 * `.returns(…)` or a `caseOf(…)` (#299 S54); `[io.ambiguous-about]` after S56 (no tags).
 */

/** `{ about: target }`, or nothing. */
const aboutOf = (target: DtoClass | undefined): ReturnsOptions | undefined =>
  target === undefined ? undefined : { about: target };

const errorsOf = (workflow: object, code: string): readonly string[] =>
  checkWorkflow(workflow as never)
    .errors.filter((found) => found.code === code)
    .map((found) => found.message);

const statusesAt = (workflow: object, at: string, of: string): ReadonlySet<SlotStatus> => {
  const { analysis } = checkWorkflow(workflow as never);
  const states = analysis === undefined ? [] : statesOf(analysis.dataflow, at as ComponentName);
  return new Set(states.map((state) => slotOf(state.scope, of as SlotKey).status));
};

// --- a two-class cycle: a writer and a reviewer, the reviewer's output given per test -------

@Agent({
  name: "loop-writer-agent",
  description: "Writes the draft, or rewrites it from the notes",
  prompt: "Write it.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
  input: { request: ArticleRequestDto, changes: optional(DraftChangesDto) },
  output: DraftDto,
})
class LoopWriterAgent {}

@Agent({
  name: "loop-publisher-agent",
  description: "Publishes the approved draft",
  prompt: "Publish it.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: DraftDto, approval: ApprovalDto },
  output: ArticleDto,
})
class LoopPublisherAgent {}

/** The loop; `{ about: target }` on the reviewer's changes (none when the target is undefined). */
const reviewLoop = (name: string, target: DtoClass | undefined): object => {
  @Agent({
    name: `${name}-reviewer-agent`,
    description: "Approves the draft or asks for changes",
    prompt: "Review it.",
    model: "moonshotai/kimi-k2.6",
    maxVisits: 3,
    input: { draft: DraftDto },
    output: oneOf(ApprovalDto, DraftChangesDto),
  })
  class ReviewerAgent {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(StoryWorkflowStart).returns(ArticleRequestDto).toAgent(LoopWriterAgent),
      agent(LoopWriterAgent)
        .returns(DraftDto)
        .toAgent(ReviewerAgent)
        .returns(oneOf(ApprovalDto, DraftChangesDto))
        .switch(
          caseOf(DraftChangesDto, aboutOf(target)).toAgent(LoopWriterAgent),
          caseOf(ApprovalDto)
            .toAgent(LoopPublisherAgent)
            .returns(ArticleDto)
            .toFinish(StoryWorkflowFinish),
        ),
    ],
  })
  class ReviewLoopWorkflow {}
  return ReviewLoopWorkflow;
};

describe("#271 AC4: a two-class cycle states its direction with { about }", () => {
  it("two-class cycle: with about it assembles, and a new draft outdates the older notes", () => {
    const workflow = reviewLoop("about", DraftDto);

    expect(checkWorkflow(workflow as never)).toMatchObject({ errors: [] });
    expect(statusesAt(workflow, "about-reviewer-agent", "DraftChangesDto")).toEqual(
      new Set([SlotStatus.Absent, SlotStatus.Outdated]),
    );
    expect(statusesAt(workflow, "loop-publisher-agent", "DraftDto")).toEqual(
      new Set([SlotStatus.Current]),
    );
  });

  it("cycle without about — hint: names the case to write it on; the review loop fixture assembles", () => {
    const workflow = reviewLoop("plain", undefined);

    expect(errorsOf(workflow, "io.ambiguous-cycle")).toEqual([
      "plain-workflow: DraftChangesDto, DraftDto are built from each other in the cycle through " +
        "loop-writer-agent, plain-reviewer-agent — say what the answers are about: write " +
        "caseOf(DraftChangesDto, { about: DraftDto }) after plain-reviewer-agent",
    ]);
    expect(checkWorkflow(StoryWorkflow)).toMatchObject({ errors: [] });
  });

  it("about the wrong class does not direct the cycle", () => {
    const workflow = reviewLoop("off", ArticleRequestDto);

    expect(errorsOf(workflow, "io.ambiguous-cycle")).toHaveLength(1);
  });

  it(".returns(CritiqueDto, { about }) and .returns(listOf(CritiqueDto), { about }) direct a cycle too", () => {
    expect(checkWorkflow(PolishWorkflow)).toMatchObject({ errors: [] });
    expect(statusesAt(PolishWorkflow, "polish-agent", "list:CritiqueDto")).toEqual(
      new Set([SlotStatus.Absent, SlotStatus.Current]),
    );
    expect(statusesAt(PolishWorkflow, "critique-action", "list:CritiqueDto")).toEqual(
      new Set([SlotStatus.Absent, SlotStatus.Outdated]),
    );
    expect(checkWorkflow(critiqueLoop(DraftDto) as never)).toMatchObject({
      errors: [],
    });
    expect(errorsOf(critiqueLoop(undefined), "io.ambiguous-cycle")).toEqual([
      expect.stringContaining(
        "write .returns(CritiqueDto, { about: DraftDto }) after single-critique-action",
      ),
    ]);
  });
});

// --- one critique, from an action -----------------------------------------------------------

function critiqueLoop(target: DtoClass | undefined): object {
  const suffix = target === undefined ? "plain" : "about";
  @Agent({
    name: `${suffix}-critiqued-writer-agent`,
    description: "Rewrites the draft by the critique",
    prompt: "Rewrite it.",
    model: "moonshotai/kimi-k2.6",
    maxVisits: 3,
    input: { request: ArticleRequestDto, critique: optional(CritiqueDto) },
    output: DraftDto,
  })
  class CritiquedWriterAgent {}
  @Action({
    name: "single-critique-action",
    description: "Critiques",
    input: { draft: DraftDto },
    output: CritiqueDto,
  })
  class SingleCritiqueAction {
    execute(): Promise<CritiqueDto> {
      return Promise.resolve({ remark: "ok" });
    }
  }
  @WorkflowFinish({
    name: `${suffix}-draft-workflow-finish`,
    description: "The draft",
    output: DraftDto,
  })
  class DraftWorkflowFinish {}
  @Router({
    name: `${suffix}-critique-gate-router`,
    description: "Rewrites or stops",
    decidedBy: DecidedBy.Model,
    model: "typesafe/jev-1.13",
    maxVisits: 3,
    input: { critique: CritiqueDto },
    routes: [
      { target: CritiquedWriterAgent, prompt: "Rewrite" },
      { target: DraftWorkflowFinish, prompt: "Stop and publish the draft" },
    ],
  })
  class CritiqueGateRouter {}
  @Workflow({
    name: `${suffix}-critique-workflow`,
    version: "1.0.0",
    flow: [
      start(StoryWorkflowStart).returns(ArticleRequestDto).toAgent(CritiquedWriterAgent),
      agent(CritiquedWriterAgent)
        .returns(DraftDto)
        .toAction(SingleCritiqueAction)
        .returns(CritiqueDto, aboutOf(target))
        .toRouter(CritiqueGateRouter)
        .chooseOne(route(CritiquedWriterAgent), route(DraftWorkflowFinish)),
    ],
  })
  class CritiqueWorkflow {}
  return CritiqueWorkflow;
}

// --- a three-class cycle: plan → draft → review → plan ---------------------------------------

@Agent({
  name: "planner-agent",
  description: "Plans the article, again after a review",
  prompt: "Plan it.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
  input: { request: ArticleRequestDto, notes: optional(DraftChangesDto) },
  output: PlanDto,
})
class PlannerAgent {}

/** The plan loop; `{ about }` on the writer's draft and on the reviewer's notes, as given. */
const planLoop = (
  name: string,
  writerAbout: DtoClass | undefined,
  reviewerAbout: DtoClass | undefined,
): object => {
  @Agent({
    name: `${name}-plan-writer-agent`,
    description: "Writes the draft from the plan",
    prompt: "Write it.",
    model: "moonshotai/kimi-k2.6",
    input: { plan: PlanDto },
    output: DraftDto,
  })
  class PlanWriterAgent {}
  @Agent({
    name: `${name}-plan-reviewer-agent`,
    description: "Approves the draft or sends notes to the planner",
    prompt: "Review it.",
    model: "moonshotai/kimi-k2.6",
    input: { draft: DraftDto },
    output: oneOf(ApprovalDto, DraftChangesDto),
  })
  class PlanReviewerAgent {}
  @Workflow({
    name: `${name}-plan-workflow`,
    version: "1.0.0",
    flow: [
      start(StoryWorkflowStart).returns(ArticleRequestDto).toAgent(PlannerAgent),
      agent(PlannerAgent)
        .returns(PlanDto)
        .toAgent(PlanWriterAgent)
        .returns(DraftDto, aboutOf(writerAbout))
        .toAgent(PlanReviewerAgent)
        .returns(oneOf(ApprovalDto, DraftChangesDto))
        .switch(
          caseOf(DraftChangesDto, aboutOf(reviewerAbout)).toAgent(PlannerAgent),
          caseOf(ApprovalDto)
            .toAgent(LoopPublisherAgent)
            .returns(ArticleDto)
            .toFinish(StoryWorkflowFinish),
        ),
    ],
  })
  class PlanLoopWorkflow {}
  return PlanLoopWorkflow;
};

describe("#271 AC4: a three-class cycle", () => {
  it("three-class cycle: without about → error with the hint", () => {
    expect(errorsOf(planLoop("plain", undefined, undefined), "io.ambiguous-cycle")).toEqual([
      "plain-plan-workflow: DraftChangesDto, DraftDto, PlanDto are built from each other in the " +
        "cycle through plain-plan-reviewer-agent, plain-plan-writer-agent, planner-agent — say what " +
        "the answers are about: write .returns(DraftDto, { about: PlanDto }) after plain-plan-writer-agent",
    ]);
  });

  it("three-class cycle: with about outdating is correct on every path", () => {
    const workflow = planLoop("about", undefined, DraftDto);

    expect(checkWorkflow(workflow as never)).toMatchObject({ errors: [] });
    expect(statusesAt(workflow, "about-plan-writer-agent", "PlanDto")).toEqual(
      new Set([SlotStatus.Current]),
    );
    expect(statusesAt(workflow, "about-plan-writer-agent", "DraftChangesDto")).toEqual(
      new Set([SlotStatus.Absent, SlotStatus.Outdated]),
    );
    expect(statusesAt(workflow, "loop-publisher-agent", "DraftDto")).toEqual(
      new Set([SlotStatus.Current]),
    );
  });

  it("the hint's own fix assembles too", () => {
    const workflow = planLoop("hinted", PlanDto, undefined);

    expect(errorsOf(workflow, "io.ambiguous-cycle")).toEqual([]);
  });
});

// --- two inputs of the class named in about (S14 after S56) ----------------------------------

describe("#299: [io.ambiguous-about] — a value about T whose producer reads T in two fields", () => {
  const editLoop = (
    name: string,
    input: Readonly<Record<string, InputFieldShape>>,
    target: DtoClass | undefined,
  ): object => {
    @Agent({
      name: `${name}-diff-reviewer-agent`,
      description: "Reviews the edit",
      prompt: "Review the edit.",
      model: "moonshotai/kimi-k2.6",
      maxVisits: 3,
      input,
      output: oneOf(ApprovalDto, DraftChangesDto),
    })
    class DiffReviewerAgent {}
    @Workflow({
      name: `${name}-edit-workflow`,
      version: "1.0.0",
      flow: [
        start(StoryWorkflowStart).returns(ArticleRequestDto).toAgent(LoopWriterAgent),
        agent(LoopWriterAgent)
          .returns(DraftDto)
          .toAgent(DiffReviewerAgent)
          .returns(oneOf(ApprovalDto, DraftChangesDto))
          .switch(
            caseOf(DraftChangesDto, aboutOf(target)).toAgent(LoopWriterAgent),
            caseOf(ApprovalDto)
              .toAgent(LoopPublisherAgent)
              .returns(ArticleDto)
              .toFinish(StoryWorkflowFinish),
          ),
      ],
    })
    class EditWorkflow {}
    return EditWorkflow;
  };

  it("the current value and its history in two fields, the notes about it → [io.ambiguous-about]", () => {
    const workflow = editLoop("twice", { draft: DraftDto, drafts: historyOf(DraftDto) }, DraftDto);

    expect(errorsOf(workflow, "io.ambiguous-about")).toEqual([
      "twice-edit-workflow: twice-diff-reviewer-agent reads 2 DraftDto fields (draft, drafts) and " +
        "its values are { about: DraftDto } — about which one? Read DraftDto in one field: with " +
        "historyOf(DraftDto) the answers are about its current value",
    ]);
    expect(errorsOf(workflow, "flow.ambiguous-field")).toEqual([]);
  });

  it("historyOf alone: the answers are about its current value, nothing is ambiguous", () => {
    const workflow = editLoop("history", { drafts: historyOf(DraftDto, { limit: 1 }) }, DraftDto);

    expect(checkWorkflow(workflow as never)).toMatchObject({ errors: [] });
  });

  it("without { about } two fields of one class are [flow.ambiguous-field] instead", () => {
    const workflow = editLoop("plain", { draft: DraftDto, drafts: historyOf(DraftDto) }, undefined);

    expect(errorsOf(workflow, "flow.ambiguous-field")).toEqual([
      "plain-edit-workflow: plain-diff-reviewer-agent has two DraftDto fields (draft, drafts) — " +
        "they read the same value; read it in one field (historyOf(DraftDto) gives the earlier " +
        "versions too)",
    ]);
    expect(errorsOf(workflow, "io.ambiguous-about")).toEqual([]);
  });
});
