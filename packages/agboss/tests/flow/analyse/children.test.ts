import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { childWorkflowOf, withChildWorkflows } from "../../../src/flow/analyse/child-workflow.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { listOf, oneOf } from "../../../src/flow/dto-wrappers.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import { LimitExceededError } from "../../../src/graph/limits.js";
import { childLines } from "../../../src/describe/inputs.js";
import {
  CompanyGradeDto,
  CompanyLinkDto,
  CompanyRejectedDto,
  CompanyReviewFailedDto,
  GradedShortlistDto,
  JobOfferDto,
} from "../fixtures/child-dtos.js";
import {
  CompanyFinderAgent,
  CompanyGradedWorkflowFinish,
  CompanyPickerAgent,
  CompanyReviewWorkflow,
  CompanyScreeningWorkflow,
  GradedShortlistWorkflowFinish,
  JobOfferAgent,
  JobOfferWorkflow,
  JobOfferWorkflowFinish,
  JobOfferWorkflowStart,
  LinkOfferWorkflow,
  NoOfferFailedWorkflowFinish,
  NoOfferRejectedWorkflowFinish,
  ReviewErrorWorkflowFinish,
  ReviewRankerAgent,
} from "../fixtures/children.fixture.js";
import { BrokenReviewWorkflow } from "../fixtures/broken-children.fixture.js";
import { CompanyDto, CompanyScoreDto, SearchRequestDto } from "../fixtures/data-dtos.js";
import { WorkflowStartTextDto } from "../fixtures/dtos.js";
import {
  CompanyCheckAgent,
  CompanyCheckWorkflow,
  CompanyScoreWorkflowFinish,
} from "../fixtures/starts.fixture.js";
import { onAgent, onStart, toAction, toAgent, toFinish, toWorkflow } from "../fixtures/paths.js";
import { inline, Ttl } from "../../../src/index.js";

/** #263 PR 1 — child workflows in the analyser: the start per edge, outputs, scope, warnings. */

type Flow = WorkflowOptions["flow"];

let count = 0;
/** A workflow of one flow, named uniquely. */
function workflowWith(flow: Flow): abstract new () => unknown {
  count += 1;
  @Workflow({
    name: `child-case-${String(count)}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow,
  })
  class ChildCaseWorkflow {}
  return ChildCaseWorkflow;
}

const checked = (flow: Flow) => checkWorkflow(workflowWith(flow));
/** A finding without the test workflow's name in front. */
const unnamed = ({ code, message }: { readonly code: string; readonly message: string }) => ({
  code,
  message: message.replace(/^child-case-\d+-workflow: /, ""),
});
const errorsOf = (flow: Flow) => checked(flow).errors.map(unnamed);
const codesOf = (flow: Flow): readonly string[] => errorsOf(flow).map((found) => found.code);

// ── children of the tests ──

@WorkflowStart({ name: "solo-grade-workflow-start", description: "A company", input: CompanyDto })
class SoloGradeWorkflowStart {}

@Agent({
  name: "solo-grader-agent",
  description: "Grades one company",
  prompt: inline("Grade it."),
  model: "moonshotai/kimi-k2.6",
  input: { company: CompanyDto },
  output: CompanyGradeDto,
})
class SoloGraderAgent {}

/** One start, one finish, no way to fail softly. */
@Workflow({
  name: "solo-grade-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(SoloGradeWorkflowStart).toAgent(SoloGraderAgent).toFinish(CompanyGradedWorkflowFinish),
  ],
})
class SoloGradeWorkflow {}

@WorkflowStart({ name: "twice-grade-workflow-start", description: "A company", input: CompanyDto })
class TwiceGradeWorkflowStart {}

@Action({
  name: "fallback-grade-action",
  description: "A grade when grading failed",
  input: { company: CompanyDto },
  output: CompanyGradeDto,
})
class FallbackGradeAction {
  async execute(): Promise<CompanyGradeDto> {
    return { grade: "unknown" };
  }
}

@WorkflowFinish({
  name: "fallback-grade-workflow-finish",
  description: "A grade when grading failed",
  output: CompanyGradeDto,
})
class FallbackGradeWorkflowFinish {}

/** Two finishes of one output class: one case for the parent; a failure finish on its side path. */
@Workflow({
  name: "twice-grade-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TwiceGradeWorkflowStart)
      .toAgent(SoloGraderAgent)
      .onError(StepFailedError, toAction(FallbackGradeAction).toFinish(FallbackGradeWorkflowFinish))
      .toFinish(CompanyGradedWorkflowFinish),
  ],
})
class TwiceGradeWorkflow {}

@WorkflowStart({
  name: "scoped-check-workflow-start",
  description: "A company and the search",
  input: { company: CompanyDto, request: SearchRequestDto },
})
class ScopedCheckWorkflowStart {}

@WorkflowStart({ name: "plain-check-workflow-start", description: "A company", input: CompanyDto })
class PlainCheckWorkflowStart {}

/** Two starts take CompanyDto; one also needs a SearchRequestDto. */
@Workflow({
  name: "narrowed-check-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ScopedCheckWorkflowStart).toAgent(CompanyCheckAgent),
    onStart(PlainCheckWorkflowStart).toAgent(CompanyCheckAgent),
    onAgent(CompanyCheckAgent).toFinish(CompanyScoreWorkflowFinish),
  ],
})
class NarrowedCheckWorkflow {}

@WorkflowStart({
  name: "search-offer-workflow-start",
  description: "Who to make an offer for, and the search",
  input: { message: WorkflowStartTextDto, request: SearchRequestDto },
})
class SearchOfferWorkflowStart {}

@Agent({
  name: "score-list-agent",
  description: "Ranks the scores",
  prompt: inline("Rank."),
  model: "moonshotai/kimi-k2.6",
  input: { scores: listOf(CompanyScoreDto) },
  output: GradedShortlistDto,
})
class ScoreListAgent {}

@Action({
  name: "log-request-action",
  description: "Logs the request",
  input: { message: WorkflowStartTextDto },
})
class LogRequestAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

// ── paths of the parents ──

const picked = () => onStart(JobOfferWorkflowStart).toAgent(CompanyPickerAgent);

const searched = () => onStart(SearchOfferWorkflowStart).toAgent(CompanyPickerAgent);

const found = () => onStart(JobOfferWorkflowStart).toAgent(CompanyFinderAgent);

const REVIEWED = oneOf(CompanyGradeDto, CompanyRejectedDto, CompanyReviewFailedDto);

const reviewCases = () =>
  [
    toAgent(JobOfferAgent).toFinish(JobOfferWorkflowFinish),
    toFinish(NoOfferRejectedWorkflowFinish),
    toFinish(NoOfferFailedWorkflowFinish),
  ] as const;

const graded = (path: ReturnType<typeof picked>) =>
  path.toAgent(JobOfferAgent).toFinish(JobOfferWorkflowFinish);

const scored = (path: ReturnType<typeof picked>) => path.toFinish(CompanyScoreWorkflowFinish);

describe("#263: the issue's examples pass", () => {
  it.each([
    ["the child, alone", CompanyReviewWorkflow],
    ["one child per item", CompanyScreeningWorkflow],
    ["one child, one way in", JobOfferWorkflow],
    ["one child reached from two places", LinkOfferWorkflow],
  ])("%s", (_, workflow) => {
    const { errors, warnings } = checkWorkflow(workflow);
    expect({ errors, warnings }).toEqual({ errors: [], warnings: [] });
  });

  it("the child is a component: start inputs → its finishes' outputs (two finishes of one class are one)", () => {
    expect(childWorkflowOf(CompanyReviewWorkflow)?.output).toEqual(REVIEWED);
    expect(childWorkflowOf(TwiceGradeWorkflow)?.outputs).toEqual([CompanyGradeDto]);
    expect(childWorkflowOf(JobOfferAgent)).toBeUndefined();
  });

  it("a child launched by a parent is typed with it: withChildWorkflows", () => {
    expect(withChildWorkflows([JobOfferWorkflow, LinkOfferWorkflow])).toEqual([
      JobOfferWorkflow,
      CompanyReviewWorkflow,
      LinkOfferWorkflow,
    ]);
  });
});

describe("#263 AC2: the start, chosen per edge", () => {
  it("start choice: per item the item's type, single launch the chain's value, each edge its own", () => {
    const lines = (workflow: abstract new () => unknown) => {
      const { analysis } = checkWorkflow(workflow);
      return analysis === undefined ? [] : childLines(analysis);
    };
    expect(lines(CompanyScreeningWorkflow)).toEqual([
      "company-finder-agent → company-review-workflow per item: company-review-workflow-start (CompanyDto)",
    ]);
    expect(lines(LinkOfferWorkflow)).toEqual([
      "company-picker-agent → company-review-workflow: company-review-workflow-start (CompanyDto)",
      "link-offer-workflow-start → company-review-workflow: company-link-review-workflow-start (CompanyLinkDto)",
    ]);
  });

  it("one start → it, also after an action without output; its fields must be on the path", () => {
    const after = onStart(JobOfferWorkflowStart)
      .toAction(LogRequestAction)
      .toWorkflow(SoloGradeWorkflow);
    expect(errorsOf([graded(after)])).toEqual([
      {
        code: "input.missing-on-path",
        message:
          "solo-grade-workflow ← solo-grade-workflow-start (CompanyDto) is not produced on the path job-offer-workflow-start → log-request-action → solo-grade-workflow — the child's scope starts with its start input only",
      },
    ]);
    expect(codesOf([graded(picked().toWorkflow(SoloGradeWorkflow))])).toEqual([]);
  });

  it("no matching: no start takes the chain's value — the starts and their inputs listed", () => {
    const path = onStart(JobOfferWorkflowStart)
      .toWorkflow(CompanyReviewWorkflow)
      .toOneOf(reviewCases());
    expect(errorsOf([path])).toContainEqual({
      code: "graph.no-matching-start",
      message:
        "job-offer-workflow-start → company-review-workflow: no start takes WorkflowStartTextDto — its starts: company-link-review-workflow-start (CompanyLinkDto), company-review-workflow-start (CompanyDto); return a value one of them takes right before it, or give the child a start that takes it",
    });
  });

  it("no matching: the path brings no value and the child has two starts", () => {
    const path = onStart(JobOfferWorkflowStart)
      .toAction(LogRequestAction)
      .toWorkflow(CompanyReviewWorkflow)
      .toOneOf(reviewCases());
    const [problem] = errorsOf([path]).filter((found) => found.code === "graph.no-matching-start");
    expect(problem?.message).toContain(
      "log-request-action → company-review-workflow: the path into it brings no value to choose one of its starts by",
    );
  });

  it("ambiguous: two starts take the value alike — told apart by a subclass", () => {
    expect(checkWorkflow(BrokenReviewWorkflow).errors).toEqual([
      {
        code: "graph.ambiguous-start",
        message:
          "broken-review-workflow: company-picker-agent → twin-grade-workflow: full-grade-workflow-start and quick-grade-workflow-start both take CompanyDto — a start is chosen by class: make one start's input a subclass (class QuickCheckRequestDto extends CompanyDto {})",
        nodes: ["twin-grade-workflow"],
      },
    ]);
  });

  it("of two starts that take the value, the one whose other required fields are on the path", () => {
    const narrowed = (path: ReturnType<typeof picked>) => {
      const { analysis, errors } = checkWorkflow(workflowWith([scored(path)]));
      return { errors, lines: analysis === undefined ? [] : childLines(analysis) };
    };
    expect(narrowed(picked().toWorkflow(NarrowedCheckWorkflow))).toEqual({
      errors: [],
      lines: [
        "company-picker-agent → narrowed-check-workflow: plain-check-workflow-start (CompanyDto)",
      ],
    });
    expect(narrowed(searched().toWorkflow(NarrowedCheckWorkflow)).errors).toEqual([
      expect.objectContaining({
        code: "graph.ambiguous-start",
        message: expect.stringContaining(
          "plain-check-workflow-start and scoped-check-workflow-start both take CompanyDto",
        ) as string,
      }),
    ]);
  });
});

describe("#263 AC18 / AC21: list and map start inputs", () => {
  it("list start input: a whole list from the parent's path, chosen by the exact shape", () => {
    const listed = found().toWorkflow(CompanyCheckWorkflow).toFinish(CompanyScoreWorkflowFinish);
    const { analysis, errors } = checkWorkflow(workflowWith([listed]));
    expect(errors).toEqual([]);
    expect(analysis === undefined ? [] : childLines(analysis)).toEqual([
      "company-finder-agent → company-check-workflow: company-batch-workflow-start (listOf(CompanyDto))",
    ]);
  });

  it("map input filled by item + path: the item fills its field, the rest from the scope or absent", () => {
    const perItem = (path: ReturnType<typeof found>) =>
      path
        .forEachItem(toWorkflow(CompanyCheckWorkflow), { takeFirst: 5 })
        .join()
        .toAgent(ScoreListAgent)
        .toFinish(GradedShortlistWorkflowFinish);
    const withRequest = onStart(SearchOfferWorkflowStart).toAgent(CompanyFinderAgent);
    const { analysis, errors } = checkWorkflow(workflowWith([perItem(withRequest)]));
    expect(errors).toEqual([]);
    expect(analysis === undefined ? [] : childLines(analysis)).toEqual([
      "company-finder-agent → company-check-workflow per item: company-check-workflow-start ({ company: CompanyDto, request: optional(SearchRequestDto) })",
    ]);
    expect(codesOf([perItem(found())])).toEqual([]);
  });

  it("a single launch fills a map start from the parent's path", () => {
    expect(codesOf([scored(searched().toWorkflow(CompanyCheckWorkflow))])).toEqual([]);
  });
});

describe("#263 AC3 / AC17: the child's output — one case per finish output class", () => {
  const switched = (cases: readonly ReturnType<typeof toFinish>[]) =>
    picked().toWorkflow(CompanyReviewWorkflow).toOneOf(cases);

  it("toOneOf exhaustive over finish classes: a missing branch", () => {
    const [grade, rejected] = reviewCases();
    expect(codesOf([switched([grade, rejected])])).toContain("flow.one-of-not-exhaustive");
  });

  it("a oneOf output is branched; a single class needs no .toOneOf", () => {
    const unwritten = picked()
      .toWorkflow(CompanyReviewWorkflow)
      .toAgent(JobOfferAgent)
      .toFinish(JobOfferWorkflowFinish);
    expect(codesOf([unwritten])).toContain("flow.one-of-not-exhaustive");
    expect(codesOf([graded(picked().toWorkflow(TwiceGradeWorkflow))])).toEqual([]);
  });

  it("caseOf after a child counts as read: a finish that does not read the case passes", () => {
    const [grade, , failed] = reviewCases();
    const unread = toFinish(ReviewErrorWorkflowFinish);
    expect(codesOf([switched([grade, unread, failed])])).toEqual([]);
  });
});

describe("#263 AC7: the child's scope is its start input", () => {
  @Workflow({
    name: "isolated-grade-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(SoloGradeWorkflowStart)
        .toAgent(JobOfferAgent) // reads a CompanyGradeDto: only the parent's path has one
        .toFinish(JobOfferWorkflowFinish),
    ],
  })
  class IsolatedGradeWorkflow {}

  it("child scope = start input: a type only the parent's scope holds is missing in the child", () => {
    const parent = picked()
      .toWorkflow(SoloGradeWorkflow)
      .toWorkflow(IsolatedGradeWorkflow)
      .toFinish(JobOfferWorkflowFinish);
    // the grade stays in the parent's scope: the child reads its start input only
    expect(errorsOf([parent])).toEqual([
      {
        code: "flow.unused-output",
        message:
          "solo-grade-workflow returns CompanyGradeDto that no node reads — read it in a node below, or remove it",
      },
    ]);
    expect(checkWorkflow(IsolatedGradeWorkflow).errors).toContainEqual(
      expect.objectContaining({
        code: "input.missing-on-path",
        message:
          "isolated-grade-workflow: job-offer-agent.grade (CompanyGradeDto) is not produced on the path solo-grade-workflow-start → job-offer-agent",
      }),
    );
  });
});

describe("#263 AC11: a per-item child with no way to fail softly", () => {
  const perItem = (child: abstract new () => unknown) =>
    found()
      .forEachItem(toWorkflow(child), { takeFirst: 5, maxConcurrency: 2 })
      .join()
      .toAgent(GradeListAgent)
      .toFinish(GradedShortlistWorkflowFinish);

  it("failure-finish warning, strict error", () => {
    const parent = workflowWith([perItem(SoloGradeWorkflow)]);
    const warning = {
      code: "graph.child-without-failure-finish",
      message:
        "company-finder-agent → forEachItem(solo-grade-workflow): solo-grade-workflow has no finish reachable from an .onError side path — one failed item will cancel all the others (FailFast); to skip failed items, catch errors in the child and end at a finish",
    };
    const plain = checkWorkflow(parent);
    const strict = checkWorkflow(parent, { strict: true });
    expect({ errors: plain.errors, warnings: plain.warnings.map(unnamed) }).toEqual({
      errors: [],
      warnings: [warning],
    });
    expect({ errors: strict.errors.map(unnamed), warnings: strict.warnings }).toEqual({
      errors: [warning],
      warnings: [],
    });
  });

  it("a child with a finish on an .onError side path, or a single child, warns nothing", () => {
    expect(checkWorkflow(workflowWith([perItem(TwiceGradeWorkflow)])).warnings).toEqual([]);
    expect(checked([graded(picked().toWorkflow(SoloGradeWorkflow))]).warnings).toEqual([]);
  });
});

@Router({
  name: "review-desk-router",
  description: "Grades the company, or hands the request back",
  decidedBy: DecidedBy.Model,
  prompt: inline("Choose."),
  model: "typesafe/jev-1.13",
  input: { company: CompanyDto },
  routes: [
    { prompt: "Grade the company", target: SoloGradeWorkflow },
    { prompt: "Stop and hand the request back", target: ReviewErrorWorkflowFinish },
  ],
})
class ReviewDeskRouter {}

@Agent({
  name: "grade-list-agent",
  description: "Ranks the grades",
  prompt: inline("Rank."),
  model: "moonshotai/kimi-k2.6",
  input: { grades: listOf(CompanyGradeDto) },
  output: GradedShortlistDto,
})
class GradeListAgent {}

describe("#263: the child's node in the graph", () => {
  it("a child mentioned as another kind is [graph.wrong-kind]", () => {
    const path = picked().toAgent(CompanyReviewWorkflow).toOneOf(reviewCases());
    expect(errorsOf([path])).toContainEqual({
      code: "graph.wrong-kind",
      message:
        "toAgent(CompanyReviewWorkflow): company-review-workflow is a workflow, not an agent — use toWorkflow(CompanyReviewWorkflow)",
    });
  });

  it("route(W): a router's route enters a child; with one start it needs no value on the edge", () => {
    const path = picked()
      .toRouter(ReviewDeskRouter)
      .onRoute(
        toWorkflow(SoloGradeWorkflow).toAgent(JobOfferAgent).toFinish(JobOfferWorkflowFinish),
      )
      .onRoute(toFinish(ReviewErrorWorkflowFinish));
    const { analysis, errors } = checked([path]);
    expect(errors).toEqual([]);
    expect(analysis === undefined ? [] : childLines(analysis)).toEqual([
      "review-desk-router → solo-grade-workflow: solo-grade-workflow-start (CompanyDto)",
    ]);
  });
});

describe("#273 S68 / S74 f: the worst case counts the child executions", () => {
  it("per item: maxItems children, maxConcurrency of them at once, one level deeper", () => {
    const [screening] = checkWorkflow(CompanyScreeningWorkflow).analysis?.worstCases ?? [];
    expect(screening).toMatchObject({
      executions: 51,
      concurrentExecutions: 4,
      depth: 1,
      parts: expect.arrayContaining(["50 × company-review-workflow"]) as unknown,
    });
  });

  it("one child: one more execution; the child alone counts only itself", () => {
    const [offer] = checkWorkflow(JobOfferWorkflow).analysis?.worstCases ?? [];
    const alone = checkWorkflow(CompanyReviewWorkflow).analysis?.worstCases ?? [];
    expect(offer).toMatchObject({ executions: 2, concurrentExecutions: 2, depth: 1 });
    expect(alone.map((worst) => worst.executions)).toEqual([1, 1]);
  });

  it("two paths into one child: each edge counts once", () => {
    const worst = checkWorkflow(LinkOfferWorkflow).analysis?.worstCases ?? [];
    expect(worst.map((each) => [each.start, each.executions, each.depth])).toEqual([
      ["link-offer-workflow-start", 2, 1],
      ["picked-offer-workflow-start", 2, 1],
    ]);
  });
});

describe("S85: toWorkflow(W) starts a side path", () => {
  const handled = (error: typeof StepFailedError | typeof LimitExceededError) =>
    picked()
      .toAgent(SoloGraderAgent)
      .onError(error, toWorkflow(SoloGradeWorkflow).toFinish(CompanyGradedWorkflowFinish))
      .toFinish(CompanyGradedWorkflowFinish);

  it("a step failure handled by a child: its start chosen, its result continued", () => {
    const { analysis, errors } = checked([handled(StepFailedError)]);
    expect(errors).toEqual([]);
    expect(analysis === undefined ? [] : childLines(analysis)).toEqual([
      "solo-grader-agent → solo-grade-workflow: solo-grade-workflow-start (CompanyDto)",
    ]);
  });

  it("a side path that can catch a limit does not start a child", () => {
    expect(codesOf([handled(LimitExceededError)])).toEqual(["graph.limit-handler-uses-model"]);
  });
});

describe("#1271: a workflow's finishes do not mix a list with another shape", () => {
  @WorkflowStart({
    name: "mixed-outputs-workflow-start",
    description: "Some companies",
    input: listOf(CompanyDto),
  })
  class MixedOutputsWorkflowStart {}

  @WorkflowFinish({
    name: "mixed-list-workflow-finish",
    description: "Every company",
    output: listOf(CompanyDto),
  })
  class MixedListWorkflowFinish {}

  @WorkflowFinish({
    name: "mixed-one-workflow-finish",
    description: "One score",
    output: CompanyScoreDto,
  })
  class MixedOneWorkflowFinish {}

  @Agent({
    name: "mixed-scorer-agent",
    description: "Scores them",
    prompt: inline("Score."),
    model: "moonshotai/kimi-k2.6",
    input: { companies: listOf(CompanyDto) },
    output: CompanyScoreDto,
  })
  class MixedScorerAgent {}

  @Workflow({
    name: "mixed-outputs-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(MixedOutputsWorkflowStart).toFinish(MixedListWorkflowFinish),
      onAgent(MixedScorerAgent).toFinish(MixedOneWorkflowFinish),
    ],
  })
  class MixedOutputsWorkflow {}

  it("is refused when the workflow is used as a child, naming both shapes", () => {
    expect(() => childWorkflowOf(MixedOutputsWorkflow)).toThrow(
      /a list output cannot be one of several/,
    );
  });
});
