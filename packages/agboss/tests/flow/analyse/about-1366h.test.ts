/**
 * #1366: the direction of a cycle through a join (#273) — a cycle built from each other through the
 * values of a parallel launch's join is refused with `[io.ambiguous-cycle]` naming the producers
 * and the join to write `{ about }` on, and accepted once it is written; a branch of a join whose
 * values are `{ about: T }` that reads `T` in two fields is `[io.ambiguous-about]`, once per target
 * in order; nothing is refused where no `{ about }` is written.
 */
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import type { DtoClass } from "../../../src/dto/types.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { historyOf, listOf, oneOf, optional } from "../../../src/flow/dto-wrappers.js";
import { DraftChangesDto } from "../fixtures/data-dtos.js";
import { ArticleRequestDto, WorkflowStartTextDto } from "../fixtures/dtos.js";
import { CriticAgent, PlanResearcherAgent } from "../fixtures/launch.fixture.js";
import { agent, caseOf, returnsEach, start, toAction } from "../fixtures/paths.js";
import { ApprovalDto, CritiqueDto, DraftDto, PlanDto, ResearchDto } from "../fixtures/review-dtos.js";

const problemsOf = (workflow: object) =>
  checkWorkflow(workflow as never)
    .errors.filter((found) => found.code.startsWith("io.ambiguous"))
    .map(({ code, message, nodes }) => ({ code, message, nodes }));

class LeftDto {
  value!: string;
}
class RightDto {
  value!: string;
}

@Agent({
  name: "pre-critic-agent",
  description: "Criticises the request before the loop",
  prompt: "Criticise.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: CritiqueDto,
})
class PreCriticAgent {}

@Agent({
  name: "pre-note-agent",
  description: "Notes the request before the loop",
  prompt: "Note.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: LeftDto,
})
class PreNoteAgent {}

/** A planner whose plan the joined critic reads and whose next round reads the critique. */
const joinLoop = (
  name: string,
  options: { about?: DtoClass; critic?: abstract new () => unknown; preJoin?: boolean },
): object => {
  @WorkflowStart({ name: `${name}-workflow-start`, description: "Ask", input: WorkflowStartTextDto })
  class LoopStart {}
  @WorkflowFinish({ name: `${name}-workflow-finish`, description: "Done", output: ApprovalDto })
  class LoopFinish {}
  @Agent({
    name: `${name}-planner-agent`,
    description: "Plans, or replans from the critique",
    prompt: "Plan.",
    model: "moonshotai/kimi-k2.6",
    maxVisits: 3,
    input: { message: WorkflowStartTextDto, critique: optional(CritiqueDto) },
    output: PlanDto,
  })
  class PlannerAgent {}
  @Agent({
    name: `${name}-decider-agent`,
    description: "Approves or asks for changes",
    prompt: "Decide.",
    model: "moonshotai/kimi-k2.6",
    maxVisits: 3,
    input: { research: ResearchDto, critique: CritiqueDto },
    output: oneOf(ApprovalDto, DraftChangesDto),
  })
  class DeciderAgent {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      options.preJoin === true
        ? start(LoopStart)
            .returns(WorkflowStartTextDto)
            .toParallelAgents(PreCriticAgent, PreNoteAgent)
            .join()
            .returns(CritiqueDto)
            .returns(LeftDto)
            .toAgent(PlannerAgent)
        : start(LoopStart).returns(WorkflowStartTextDto).toAgent(PlannerAgent),
      agent(PlannerAgent)
        .returns(PlanDto)
        .toParallelAgents(PlanResearcherAgent, options.critic ?? CriticAgent)
        .join()
        .returns(ResearchDto)
        .returns(CritiqueDto, options.about === undefined ? undefined : { about: options.about })
        .toAgent(DeciderAgent)
        .returns(oneOf(ApprovalDto, DraftChangesDto))
        .switch(
          caseOf(DraftChangesDto).toAgent(PlannerAgent),
          caseOf(ApprovalDto).toFinish(LoopFinish),
        ),
    ],
  })
  class JoinLoopWorkflow {}
  return JoinLoopWorkflow;
};

describe("#1366: a cycle through the join of a parallel launch", () => {
  it("built from each other with no { about }: refused once, naming the planner and the cycle", () => {
    expect(problemsOf(joinLoop("jn", {}))).toStrictEqual([
      {
        code: "io.ambiguous-cycle",
        message:
          "jn-workflow: CritiqueDto, PlanDto are built from each other in the cycle through " +
          "jn-decider-agent, jn-planner-agent — say what the answers are about: write " +
          ".returns(PlanDto, { about: CritiqueDto }) after jn-planner-agent",
        nodes: ["critic-agent", "jn-planner-agent"],
      },
    ]);
  });

  it("with { about } written on the join's value it is accepted", () => {
    expect(problemsOf(joinLoop("ja", { about: PlanDto }))).toStrictEqual([]);
    expect(checkWorkflow(joinLoop("jb", { about: PlanDto }) as never).errors).toStrictEqual([]);
  });

  it("about the wrong class (the research) does not direct it", () => {
    expect(problemsOf(joinLoop("jw", { about: ResearchDto })).map((found) => found.code)).toStrictEqual([
      "io.ambiguous-cycle",
    ]);
  });
});

@Agent({
  name: "double-critic-agent",
  description: "Criticises the plan, reading it twice",
  prompt: "Criticise the plan.",
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto, plans: historyOf(PlanDto) },
  output: CritiqueDto,
})
class DoubleCriticAgent {}

describe("#1366: a branch of a join that reads the class its values are about in two fields", () => {
  it("[io.ambiguous-about] on the branch, naming its fields", () => {
    expect(problemsOf(joinLoop("jd", { about: PlanDto, critic: DoubleCriticAgent }))).toStrictEqual([
      {
        code: "io.ambiguous-about",
        message:
          "jd-workflow: double-critic-agent reads 2 PlanDto fields (plan, plans) and its values are " +
          "{ about: PlanDto } — about which one? Read PlanDto in one field: with historyOf(PlanDto) " +
          "the answers are about its current value",
        nodes: ["double-critic-agent"],
      },
    ]);
  });

  it("without { about } two fields of one class are not [io.ambiguous-about]", () => {
    expect(problemsOf(joinLoop("je", { critic: DoubleCriticAgent })).map((found) => found.code)).not.toContain(
      "io.ambiguous-about",
    );
  });
});

@Agent({
  name: "draft-researcher-agent",
  description: "Researches the draft",
  prompt: "Research.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: DraftDto },
  output: ResearchDto,
})
class DraftResearcherAgent {}

/** A draft is researched twice in parallel; the planner plans from the researches and the drafter redrafts from the plan. */
const fanOutLoop = (name: string, about: DtoClass | undefined, plannerReadsDraft = false): object => {
  @WorkflowStart({ name: `${name}-workflow-start`, description: "Ask", input: WorkflowStartTextDto })
  class FanStart {}
  @WorkflowFinish({ name: `${name}-workflow-finish`, description: "Done", output: ApprovalDto })
  class FanFinish {}
  @Agent({
    name: `${name}-drafter-agent`,
    description: "Writes a draft, or redrafts for the plan",
    prompt: "Draft.",
    model: "moonshotai/kimi-k2.6",
    maxVisits: 3,
    input: { message: WorkflowStartTextDto, plan: optional(PlanDto), previous: optional(DraftDto) },
    output: DraftDto,
  })
  class DrafterAgent {}
  @Agent({
    name: `${name}-planner-agent`,
    description: "Plans from the researches, or approves",
    prompt: "Plan.",
    model: "moonshotai/kimi-k2.6",
    maxVisits: 3,
    input: plannerReadsDraft ? { researches: listOf(ResearchDto), draft: DraftDto } : { researches: listOf(ResearchDto) },
    output: oneOf(PlanDto, ApprovalDto),
  })
  class PlannerAgent {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(FanStart).returns(WorkflowStartTextDto).toAgent(DrafterAgent),
      agent(DrafterAgent)
        .returns(DraftDto)
        .toParallelAgents(DraftResearcherAgent, DraftResearcherAgent)
        .join()
        .returns(listOf(ResearchDto), about === undefined ? undefined : { about })
        .toAgent(PlannerAgent)
        .returns(oneOf(PlanDto, ApprovalDto))
        .switch(caseOf(PlanDto).toAgent(DrafterAgent), caseOf(ApprovalDto).toFinish(FanFinish)),
    ],
  })
  class FanOutWorkflow {}
  return FanOutWorkflow;
};

describe("#1366: the hint of a cycle whose join branches read the first class", () => {
  it("names the join to write { about } on, and the branch among the producers", () => {
    expect(problemsOf(fanOutLoop("afan", undefined))).toStrictEqual([
      {
        code: "io.ambiguous-cycle",
        message:
          "afan-workflow: DraftDto, PlanDto, listOf(ResearchDto) are built from each other in the cycle " +
          "through afan-drafter-agent, afan-planner-agent — say what the answers are about: write " +
          ".join().returns(listOf(ResearchDto), { about: DraftDto }) after afan-drafter-agent → " +
          "toParallelAgents(draft-researcher-agent, draft-researcher-agent)",
        nodes: ["afan-drafter-agent", "afan-planner-agent", "draft-researcher-agent"],
      },
    ]);
  });

  it("two edges into the hint's target: the producer first by name is named, not the first found", () => {
    const [found] = problemsOf(fanOutLoop("zfan", undefined, true));

    expect(found?.message).toContain(
      "write .join().returns(listOf(ResearchDto), { about: DraftDto }) after zfan-drafter-agent",
    );
  });

  it("with { about } on the join's value it is accepted", () => {
    expect(problemsOf(fanOutLoop("aok", DraftDto))).toStrictEqual([]);
  });
});

@Agent({
  name: "outside-critic-agent",
  description: "Criticises the plan after the approval",
  prompt: "Criticise.",
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: CritiqueDto,
})
class OutsideCriticAgent {}

@Agent({
  name: "outside-researcher-agent",
  description: "Researches the plan after the approval",
  prompt: "Research.",
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: ResearchDto,
})
class OutsideResearcherAgent {}

/** The join loop, whose approval ends in a second join of its own, outside the cycle. */
const loopWithJoinAfter = (name: string): object => {
  @WorkflowStart({ name: `${name}-workflow-start`, description: "Ask", input: WorkflowStartTextDto })
  class AfterStart {}
  @WorkflowFinish({ name: `${name}-workflow-finish`, description: "Done", output: ApprovalDto })
  class AfterFinish {}
  @Agent({
    name: `${name}-planner-agent`,
    description: "Plans, or replans from the critique",
    prompt: "Plan.",
    model: "moonshotai/kimi-k2.6",
    maxVisits: 3,
    input: { message: WorkflowStartTextDto, critique: optional(CritiqueDto) },
    output: PlanDto,
  })
  class PlannerAgent {}
  @Agent({
    name: `${name}-decider-agent`,
    description: "Approves or asks for changes",
    prompt: "Decide.",
    model: "moonshotai/kimi-k2.6",
    maxVisits: 3,
    input: { research: ResearchDto, critique: CritiqueDto },
    output: oneOf(ApprovalDto, DraftChangesDto),
  })
  class DeciderAgent {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(AfterStart).returns(WorkflowStartTextDto).toAgent(PlannerAgent),
      agent(PlannerAgent)
        .returns(PlanDto)
        .toParallelAgents(PlanResearcherAgent, CriticAgent)
        .join()
        .returns(ResearchDto)
        .returns(CritiqueDto)
        .toAgent(DeciderAgent)
        .returns(oneOf(ApprovalDto, DraftChangesDto))
        .switch(
          caseOf(DraftChangesDto).toAgent(PlannerAgent),
          caseOf(ApprovalDto)
            .toParallelAgents(OutsideResearcherAgent, OutsideCriticAgent)
            .join()
            .returns(ResearchDto)
            .returns(CritiqueDto)
            .toFinish(AfterFinish),
        ),
    ],
  })
  class JoinAfterWorkflow {}
  return JoinAfterWorkflow;
};

describe("#1366: the producers of a cycle are its nodes and the branches of the joins inside it", () => {
  it("a join after the cycle does not add its branches to the cycle's producers", () => {
    const found = problemsOf(loopWithJoinAfter("ja"));

    expect(found.map((problem) => problem.code)).toStrictEqual(["io.ambiguous-cycle"]);
    expect(found[0]?.nodes).toStrictEqual(["critic-agent", "ja-planner-agent"]);
  });
});

describe("#1366: an about-writer that reads the class in one field and others of other classes", () => {
  it("is not ambiguous: only the fields of the class its values are about count", () => {
    @Agent({
      name: "wide-reviewer-agent",
      description: "Reviews the draft against the request",
      prompt: "Review.",
      model: "moonshotai/kimi-k2.6",
      maxVisits: 3,
      input: { draft: DraftDto, request: ArticleRequestDto },
      output: oneOf(ApprovalDto, DraftChangesDto),
    })
    class WideReviewerAgent {}
    @Agent({
      name: "wide-writer-agent",
      description: "Writes the draft, or rewrites it from the notes",
      prompt: "Write.",
      model: "moonshotai/kimi-k2.6",
      maxVisits: 3,
      input: { request: ArticleRequestDto, changes: optional(DraftChangesDto) },
      output: DraftDto,
    })
    class WideWriterAgent {}
    @WorkflowStart({ name: "wide-workflow-start", description: "Ask", input: ArticleRequestDto })
    class WideStart {}
    @WorkflowFinish({ name: "wide-workflow-finish", description: "Done", output: ApprovalDto })
    class WideFinish {}
    @Workflow({
      name: "wide-workflow",
      version: "1.0.0",
      flow: [
        start(WideStart).returns(ArticleRequestDto).toAgent(WideWriterAgent),
        agent(WideWriterAgent)
          .returns(DraftDto)
          .toAgent(WideReviewerAgent)
          .returns(oneOf(ApprovalDto, DraftChangesDto))
          .switch(
            caseOf(DraftChangesDto, { about: DraftDto }).toAgent(WideWriterAgent),
            caseOf(ApprovalDto).toFinish(WideFinish),
          ),
      ],
    })
    class WideWorkflow {}

    expect(checkWorkflow(WideWorkflow as never).errors).toStrictEqual([]);
  });
});

describe("#1366: a producer whose values are about two classes, each read in two fields", () => {
  it("[io.ambiguous-about] once per class, in the classes' order", () => {
    @Agent({
      name: "two-targets-planner-agent",
      description: "Plans",
      prompt: "Plan.",
      model: "moonshotai/kimi-k2.6",
      input: { request: ArticleRequestDto },
      output: PlanDto,
    })
    class TwoPlannerAgent {}
    @Agent({
      name: "two-targets-writer-agent",
      description: "Writes the draft from the plan",
      prompt: "Write.",
      model: "moonshotai/kimi-k2.6",
      input: { plan: PlanDto },
      output: DraftDto,
    })
    class TwoWriterAgent {}
    @Agent({
      name: "two-targets-reviewer-agent",
      description: "Reviews the draft against the plan",
      prompt: "Review.",
      model: "moonshotai/kimi-k2.6",
      input: { plan: PlanDto, plans: historyOf(PlanDto), draft: DraftDto, drafts: historyOf(DraftDto) },
      output: oneOf(ApprovalDto, DraftChangesDto),
    })
    class TwoReviewerAgent {}
    @WorkflowStart({ name: "two-targets-workflow-start", description: "Ask", input: ArticleRequestDto })
    class TwoStart {}
    @WorkflowFinish({ name: "two-targets-workflow-finish", description: "Done", output: ApprovalDto })
    class TwoFinish {}
    @Workflow({
      name: "two-targets-workflow",
      version: "1.0.0",
      flow: [
        start(TwoStart).returns(ArticleRequestDto).toAgent(TwoPlannerAgent),
        agent(TwoPlannerAgent)
          .returns(PlanDto)
          .toAgent(TwoWriterAgent)
          .returns(DraftDto)
          .toAgent(TwoReviewerAgent)
          .returns(oneOf(ApprovalDto, DraftChangesDto))
          .switch(
            caseOf(ApprovalDto, { about: PlanDto }).toFinish(TwoFinish),
            caseOf(DraftChangesDto, { about: DraftDto }).toFinish(TwoFinish),
          ),
      ],
    })
    class TwoTargetsWorkflow {}

    expect(problemsOf(TwoTargetsWorkflow).map((problem) => problem.message.split(" reads ")[1]?.split(" fields")[0])).toStrictEqual([
      "2 DraftDto",
      "2 PlanDto",
    ]);
  });
});

/** 13 optional fields: 2^13 reachable scopes at the next node, past the scope guard. */
const wideDtos = Array.from({ length: 13 }, (_, index) => {
  const name = `Wide${String(index + 1)}Dto`;
  return {
    [name]: class {
      value!: string;
    },
  }[name];
}).filter((dto) => dto !== undefined);

describe("#1366: past the scope guard a cycle is not judged, even when the wide node is elsewhere", () => {
  it("[flow.analysis-too-large] says so and the un-directed cycle is not reported on partial states", () => {
    const optionalFields = Object.fromEntries(
      wideDtos.map((dto, index) => [`field${String(index + 1)}`, optional(dto)]),
    );
    @WorkflowStart({
      name: "guarded-workflow-start",
      description: "A request",
      input: { request: ArticleRequestDto },
    })
    class GuardedStart {}
    @WorkflowStart({
      name: "guarded-wide-workflow-start",
      description: "Many optional fields",
      input: optionalFields,
    })
    class GuardedWideStart {}
    @WorkflowFinish({ name: "guarded-workflow-finish", description: "Done", output: ApprovalDto })
    class GuardedFinish {}
    @WorkflowFinish({
      name: "guarded-wide-workflow-finish",
      description: "Reads them all",
      input: optionalFields,
      output: ApprovalDto,
    })
    class GuardedWideFinish {
      finish(): ApprovalDto {
        return { reason: "" };
      }
    }
    @Agent({
      name: "guarded-writer-agent",
      description: "Writes the draft, or rewrites it from the notes",
      prompt: "Write.",
      model: "moonshotai/kimi-k2.6",
      maxVisits: 3,
      input: { request: ArticleRequestDto, changes: optional(DraftChangesDto) },
      output: DraftDto,
    })
    class GuardedWriterAgent {}
    @Agent({
      name: "guarded-reviewer-agent",
      description: "Approves the draft or asks for changes",
      prompt: "Review.",
      model: "moonshotai/kimi-k2.6",
      maxVisits: 3,
      input: { draft: DraftDto },
      output: oneOf(ApprovalDto, DraftChangesDto),
    })
    class GuardedReviewerAgent {}
    @Workflow({
      name: "guarded-workflow",
      version: "1.0.0",
      flow: [
        start(GuardedStart).returns(ArticleRequestDto).toAgent(GuardedWriterAgent),
        returnsEach(start(GuardedWideStart), wideDtos.map(optional)).toFinish(GuardedWideFinish),
        agent(GuardedWriterAgent)
          .returns(DraftDto)
          .toAgent(GuardedReviewerAgent)
          .returns(oneOf(ApprovalDto, DraftChangesDto))
          .switch(
            caseOf(DraftChangesDto).toAgent(GuardedWriterAgent),
            caseOf(ApprovalDto).toFinish(GuardedFinish),
          ),
      ],
    })
    class GuardedWorkflow {}

    const codes = checkWorkflow(GuardedWorkflow as never).errors.map((found) => found.code);

    expect(codes).toContain("flow.analysis-too-large");
    expect(codes).not.toContain("io.ambiguous-cycle");
  });
});

describe("#1366: a node that is not in a cycle is never judged for one", () => {
  it("an agent that reads two classes and answers with either of them is not [io.ambiguous-cycle]", () => {
    @WorkflowStart({
      name: "pair-workflow-start",
      description: "Two values",
      input: { left: LeftDto, right: RightDto },
    })
    class PairStart {}
    @WorkflowFinish({ name: "pair-left-workflow-finish", description: "Left", output: LeftDto })
    class PairLeftFinish {}
    @WorkflowFinish({ name: "pair-right-workflow-finish", description: "Right", output: RightDto })
    class PairRightFinish {}
    @Agent({
      name: "pair-agent",
      description: "Picks one of the two",
      prompt: "Pick.",
      model: "moonshotai/kimi-k2.6",
      input: { left: LeftDto, right: RightDto },
      output: oneOf(LeftDto, RightDto),
    })
    class PairAgent {}
    @Workflow({
      name: "pair-workflow",
      version: "1.0.0",
      flow: [
        returnsEach(start(PairStart), [LeftDto, RightDto])
          .toAgent(PairAgent)
          .returns(oneOf(LeftDto, RightDto))
          .switch(caseOf(LeftDto).toFinish(PairLeftFinish), caseOf(RightDto).toFinish(PairRightFinish)),
      ],
    })
    class PairWorkflow {}

    expect(checkWorkflow(PairWorkflow as never).errors).toStrictEqual([]);
  });
});

@Agent({
  name: "item-critic-agent",
  description: "Criticises one plan",
  prompt: "Criticise.",
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: CritiqueDto,
})
class ItemCriticAgent {}

describe("#1366: a per-item launch's item is not written by its launcher", () => {
  it("planner → one critic per plan → planner is not [io.ambiguous-cycle]: the item class is the branch's input, not the planner's output", () => {
    @WorkflowStart({ name: "items-workflow-start", description: "Ask", input: WorkflowStartTextDto })
    class ItemsStart {}
    @WorkflowFinish({ name: "items-workflow-finish", description: "Done", output: ApprovalDto })
    class ItemsFinish {}
    @Agent({
      name: "items-planner-agent",
      description: "Plans several, or replans from the critiques",
      prompt: "Plan.",
      model: "moonshotai/kimi-k2.6",
      maxVisits: 3,
      input: { message: WorkflowStartTextDto, critiques: optional(listOf(CritiqueDto)) },
      output: listOf(PlanDto),
    })
    class ItemsPlannerAgent {}
    @Agent({
      name: "items-decider-agent",
      description: "Approves or asks for changes",
      prompt: "Decide.",
      model: "moonshotai/kimi-k2.6",
      maxVisits: 3,
      input: { critiques: listOf(CritiqueDto) },
      output: oneOf(ApprovalDto, DraftChangesDto),
    })
    class ItemsDeciderAgent {}
    @Workflow({
      name: "items-workflow",
      version: "1.0.0",
      flow: [
        start(ItemsStart).returns(WorkflowStartTextDto).toAgent(ItemsPlannerAgent),
        agent(ItemsPlannerAgent)
          .returns(listOf(PlanDto))
          .toParallelAgents(ItemCriticAgent, { maxConcurrency: 2, maxItems: 5 })
          .join()
          .returns(listOf(CritiqueDto))
          .toAgent(ItemsDeciderAgent)
          .returns(oneOf(ApprovalDto, DraftChangesDto))
          .switch(
            caseOf(DraftChangesDto).toAgent(ItemsPlannerAgent),
            caseOf(ApprovalDto).toFinish(ItemsFinish),
          ),
      ],
    })
    class ItemsWorkflow {}

    expect(checkWorkflow(ItemsWorkflow as never).errors).toStrictEqual([]);
  });
});

describe("#1366: a join before the cycle is not part of it", () => {
  it("its branches are not producers of the cycle", () => {
    const found = problemsOf(joinLoop("pre", { preJoin: true }));

    expect(found.map((problem) => problem.code)).toStrictEqual(["io.ambiguous-cycle"]);
    expect(found[0]?.nodes).toStrictEqual(["critic-agent", "pre-planner-agent"]);
  });
});

describe("#1366: a cycle that only the join's error path closes", () => {
  it("the branches of a join whose happy path leaves the loop are not producers of the cycle", () => {
    @WorkflowStart({ name: "retry-workflow-start", description: "Ask", input: WorkflowStartTextDto })
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
        research: optional(ResearchDto),
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
        start(RetryStart).returns(WorkflowStartTextDto).toAgent(RetryPlannerAgent),
        agent(RetryPlannerAgent)
          .returns(PlanDto)
          .toParallelAgents(PlanResearcherAgent, CriticAgent)
          .join()
          .onJoinError(
            StepFailedError,
            toAction(RetryNoteAction).returns(LeftDto).toAgent(RetryPlannerAgent),
          )
          .returns(ResearchDto)
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
