import { describe, expect, it } from "vitest";
import { analyseWorkflow, checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { statesOf } from "../../../src/flow/analyse/dataflow.js";
import { slotOf, SlotStatus, type SlotKey } from "../../../src/flow/analyse/scope.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { oneOf, optional } from "../../../src/flow/dto-wrappers.js";
import type { ComponentName } from "../../../src/flow/registry.js";
import { GraphRuleError } from "../../../src/graph/rule-error.js";
import { DraftChangesDto } from "../fixtures/data-dtos.js";
import { ArticleDto, ArticleRequestDto, WorkflowStartTextDto } from "../fixtures/dtos.js";
import { agent, caseOf, route, router, start } from "../fixtures/paths.js";
import {
  ApprovalDto,
  CandidateProfileDto,
  DraftDto,
  JobListDto,
  JobPickDto,
  JobScoresDto,
  PlanDto,
  ResearchDto,
} from "../fixtures/review-dtos.js";
import {
  PublisherAgent,
  ResearcherAgent,
  StoryReviewerAgent,
  StoryWorkflow,
  StoryWorkflowFinish,
  StoryWorkflowStart,
  StoryWriterAgent,
} from "../fixtures/review.fixture.js";

/** #271 PR 1: outdating in the analyser (S10) and `[input.outdated-on-path]` (rule 6). */

const slot = (text: string): SlotKey => text as SlotKey;
const node = (text: string): ComponentName => text as ComponentName;

/** The status of a slot in every abstract scope that reaches a node. */
function statusesAt(workflow: object, at: string, of: string): readonly SlotStatus[] {
  const { analysis } = checkWorkflow(workflow as never);
  if (analysis === undefined) return [];
  return statesOf(analysis.dataflow, node(at)).map((state) => slotOf(state.scope, slot(of)).status);
}

const codesOf = (workflow: object): readonly string[] =>
  checkWorkflow(workflow as never).errors.map((found) => found.code);

const messagesOf = (workflow: object, code: string): readonly string[] =>
  checkWorkflow(workflow as never)
    .errors.filter((found) => found.code === code)
    .map((found) => found.message);

// --- the hub graph of #271: the same agents behind a router that may send anywhere -----------

@Router({
  name: "editor-router",
  description: "Sends the article to whoever works on it next",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  maxVisits: 8,
  input: {
    request: ArticleRequestDto,
  },
  routes: [
    { target: ResearcherAgent, prompt: "Research is missing" },
    { target: StoryWriterAgent, prompt: "Write or rewrite" },
    { target: StoryReviewerAgent, prompt: "Review the draft" },
    { target: PublisherAgent, prompt: "Stop and publish: the draft is approved" },
  ],
})
class EditorRouter {}

@Workflow({
  name: "hub-workflow",
  version: "1.0.0",
  flow: [
    start(StoryWorkflowStart).returns(ArticleRequestDto).toRouter(EditorRouter),
    router(EditorRouter).chooseOne(
      route(ResearcherAgent).returns(ResearchDto).toRouter(EditorRouter),
      route(StoryWriterAgent).returns(DraftDto).toRouter(EditorRouter),
      route(StoryReviewerAgent)
        .returns(oneOf(ApprovalDto, DraftChangesDto))
        .switch(
          caseOf(ApprovalDto, { about: DraftDto }).toRouter(EditorRouter),
          caseOf(DraftChangesDto, { about: DraftDto }).toRouter(EditorRouter),
        ),
      route(PublisherAgent).returns(ArticleDto).toFinish(StoryWorkflowFinish),
    ),
  ],
})
class HubWorkflow {}

// --- outdating without a cycle: a job list for an old profile, three levels -----------------

@WorkflowStart({
  name: "jobs-workflow-start",
  description: "A candidate",
  input: CandidateProfileDto,
})
class JobsWorkflowStart {}

@Agent({
  name: "job-search-agent",
  description: "Finds jobs for the profile",
  prompt: "Find jobs.",
  model: "moonshotai/kimi-k2.6",
  input: { profile: CandidateProfileDto },
  output: JobListDto,
})
class JobSearchAgent {}

@Agent({
  name: "job-scoring-agent",
  description: "Scores the jobs",
  prompt: "Score them.",
  model: "moonshotai/kimi-k2.6",
  input: { jobs: JobListDto },
  output: JobScoresDto,
})
class JobScoringAgent {}

@Agent({
  name: "profile-editor-agent",
  description: "Corrects the profile",
  prompt: "Correct it.",
  model: "moonshotai/kimi-k2.6",
  input: { profile: CandidateProfileDto },
  output: CandidateProfileDto,
})
class ProfileEditorAgent {}

@Agent({
  name: "job-picker-agent",
  description: "Picks the job to apply for",
  prompt: "Pick one.",
  model: "moonshotai/kimi-k2.6",
  input: { scores: JobScoresDto, profile: CandidateProfileDto },
  output: JobPickDto,
})
class JobPickerAgent {}

@WorkflowFinish({ name: "pick-workflow-finish", description: "The pick", output: JobPickDto })
class PickWorkflowFinish {}

@Workflow({
  name: "stale-scores-workflow",
  version: "1.0.0",
  flow: [
    start(JobsWorkflowStart)
      .returns(CandidateProfileDto)
      .toAgent(JobSearchAgent)
      .returns(JobListDto)
      .toAgent(JobScoringAgent)
      .returns(JobScoresDto)
      .toAgent(ProfileEditorAgent)
      .returns(CandidateProfileDto)
      .toAgent(JobPickerAgent)
      .returns(JobPickDto)
      .toFinish(PickWorkflowFinish),
  ],
})
class StaleScoresWorkflow {}

@Workflow({
  name: "fresh-scores-workflow",
  version: "1.0.0",
  flow: [
    start(JobsWorkflowStart)
      .returns(CandidateProfileDto)
      .toAgent(ProfileEditorAgent)
      .returns(CandidateProfileDto)
      .toAgent(JobSearchAgent)
      .returns(JobListDto)
      .toAgent(JobScoringAgent)
      .returns(JobScoresDto)
      .toAgent(JobPickerAgent)
      .returns(JobPickDto)
      .toFinish(PickWorkflowFinish),
  ],
})
class FreshScoresWorkflow {}

@Router({
  name: "jobs-router",
  description: "Decides on the scored jobs",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  input: { jobs: JobListDto },
  routes: [{ target: JobPickerAgent, prompt: "Pick a job" }],
})
class JobsRouter {}

@Workflow({
  name: "stale-router-workflow",
  version: "1.0.0",
  flow: [
    start(JobsWorkflowStart)
      .returns(CandidateProfileDto)
      .toAgent(JobSearchAgent)
      .returns(JobListDto)
      .toAgent(JobScoringAgent)
      .returns(JobScoresDto)
      .toAgent(ProfileEditorAgent)
      .returns(CandidateProfileDto)
      .toRouter(JobsRouter)
      .chooseOne(route(JobPickerAgent).returns(JobPickDto).toFinish(PickWorkflowFinish)),
  ],
})
class StaleRouterWorkflow {}

describe("#271 AC2: a new value outdates everything built from the older one", () => {
  it("chain of 3 levels: a renewed profile outdates the jobs and the scores built from them", () => {
    expect(messagesOf(StaleScoresWorkflow, "input.outdated-on-path")).toEqual([
      "stale-scores-workflow: job-picker-agent.scores (JobScoresDto) is outdated on the path " +
        "jobs-workflow-start → job-search-agent → job-scoring-agent → profile-editor-agent → " +
        "job-picker-agent (built from JobListDto, outdated when profile-editor-agent replaced " +
        "CandidateProfileDto) — renew it on that path before job-picker-agent, or read it before " +
        "it is outdated",
    ]);
  });

  it("outdating without a cycle needs nothing written: renewing before the search assembles", () => {
    expect(checkWorkflow(FreshScoresWorkflow)).toMatchObject({ errors: [] });
  });

  it("the outdated values stay in the scope as Outdated, never Absent", () => {
    expect(statusesAt(StaleScoresWorkflow, "job-picker-agent", "JobListDto")).toEqual([
      SlotStatus.Outdated,
    ]);
  });
});

describe("#271 AC5: [input.missing-on-path] counts current values; the hub graph fails", () => {
  it("hub graph fails, review loop assembles", () => {
    const missing = messagesOf(HubWorkflow, "input.missing-on-path");
    const outdated = messagesOf(HubWorkflow, "input.outdated-on-path");

    expect(missing).toContain(
      "hub-workflow: story-writer-agent.research (ResearchDto) is not produced on the path " +
        "story-workflow-start → editor-router → story-writer-agent",
    );
    expect(missing).toContain(
      "hub-workflow: story-reviewer-agent.draft (DraftDto) is not produced on the path " +
        "story-workflow-start → editor-router → story-reviewer-agent",
    );
    expect(outdated.find((text) => text.includes("publisher-agent.approval"))).toMatch(
      /publisher-agent\.approval \(ApprovalDto\) is outdated on the path .*story-reviewer-agent → editor-router → story-writer-agent → editor-router → publisher-agent \(about DraftDto, replaced by story-writer-agent\)/,
    );
    expect(checkWorkflow(StoryWorkflow)).toMatchObject({ errors: [] });
  });
});

describe("#271 AC6: a router's fields are proven current like any node's", () => {
  it("router field outdated on a path", () => {
    expect(messagesOf(StaleRouterWorkflow, "input.outdated-on-path")).toContainEqual(
      expect.stringContaining(
        "jobs-router.jobs (JobListDto) is outdated on the path jobs-workflow-start → " +
          "job-search-agent → job-scoring-agent → profile-editor-agent → jobs-router (built from " +
          "CandidateProfileDto, replaced by profile-editor-agent)",
      ),
    );
  });
});

describe("#271 rule 5: in the review loop a new draft outdates the notes, never the reverse", () => {
  it("a new draft outdates the notes about the older one: the reviewer sees them Outdated", () => {
    expect(statusesAt(StoryWorkflow, "story-reviewer-agent", "DraftChangesDto")).toEqual(
      expect.arrayContaining([SlotStatus.Absent, SlotStatus.Outdated]),
    );
    expect(statusesAt(StoryWorkflow, "story-reviewer-agent", "DraftChangesDto")).not.toContain(
      SlotStatus.Current,
    );
  });

  it("a new answer never outdates the draft: the writer and the publisher see it current", () => {
    expect(new Set(statusesAt(StoryWorkflow, "story-writer-agent", "DraftChangesDto"))).toEqual(
      new Set([SlotStatus.Absent, SlotStatus.Current]),
    );
    expect(new Set(statusesAt(StoryWorkflow, "publisher-agent", "DraftDto"))).toEqual(
      new Set([SlotStatus.Current]),
    );
    expect(new Set(statusesAt(StoryWorkflow, "publisher-agent", "ApprovalDto"))).toEqual(
      new Set([SlotStatus.Current]),
    );
  });

  it("a loop of any number of rounds: the fixed point holds one current draft, notes about it only", () => {
    const analysis = analyseWorkflow(StoryWorkflow);
    const scopes = [...analysis.dataflow.scopes.values()].flatMap((found) => [
      ...found.states.values(),
    ]);
    const notesAboutAnOlderDraft = scopes.filter(
      (state) =>
        slotOf(state.scope, slot("DraftChangesDto")).status === SlotStatus.Current &&
        slotOf(state.scope, slot("DraftDto")).status !== SlotStatus.Current,
    );

    expect(notesAboutAnOlderDraft).toEqual([]);
    expect(
      scopes.some((state) => slotOf(state.scope, slot("DraftDto")).status === SlotStatus.Outdated),
    ).toBe(false);
  });
});

// --- a field outdated on one path only: the gate router lets an approval go stale ----------

@Agent({
  name: "gate-writer-agent",
  description: "Writes the draft, or rewrites it from the notes",
  prompt: "Write it.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
  input: { request: ArticleRequestDto, changes: optional(DraftChangesDto) },
  output: DraftDto,
})
class GateWriterAgent {}

@Agent({
  name: "loose-publisher-agent",
  description: "Publishes, approved or not",
  prompt: "Publish.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: DraftDto, approval: optional(ApprovalDto) },
  output: ArticleDto,
})
class LoosePublisherAgent {}

@Agent({
  name: "strict-publisher-agent",
  description: "Publishes an approved draft",
  prompt: "Publish.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: DraftDto, approval: ApprovalDto },
  output: ArticleDto,
})
class StrictPublisherAgent {}

const gateRouter = (name: string, publisher: object): object => {
  @Router({
    name,
    description: "Reviews again or publishes",
    decidedBy: DecidedBy.Model,
    model: "typesafe/jev-1.13",
    maxVisits: 6,
    input: { draft: DraftDto },
    routes: [
      { target: StoryReviewerAgent, prompt: "Review it" },
      { target: publisher as never, prompt: "Stop and publish" },
    ],
  })
  class GateRouter {}
  return GateRouter;
};

const gateWorkflow = (name: string, publisher: object): object => {
  const gate = gateRouter(`${name}-router`, publisher);
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(StoryWorkflowStart).returns(ArticleRequestDto).toAgent(GateWriterAgent),
      agent(GateWriterAgent)
        .returns(DraftDto)
        .toRouter(gate as never),
      router(gate as never).chooseOne(
        route(StoryReviewerAgent)
          .returns(oneOf(ApprovalDto, DraftChangesDto))
          .switch(
            caseOf(DraftChangesDto, { about: DraftDto }).toAgent(GateWriterAgent),
            caseOf(ApprovalDto, { about: DraftDto }).toRouter(gate as never),
          ),
        route(publisher as never)
          .returns(ArticleDto)
          .toFinish(StoryWorkflowFinish),
      ),
    ],
  })
  class GateWorkflow {}
  return GateWorkflow;
};

describe("#271 AC2: a field outdated on one path only fails, required or optional", () => {
  const stale =
    /approval \(.*ApprovalDto\)+ is outdated on the path story-workflow-start → gate-writer-agent → \S+ → story-reviewer-agent → \S+ → story-reviewer-agent → gate-writer-agent → \S+ → \S+-publisher-agent \(about DraftDto, replaced by gate-writer-agent\)/;

  it("outdated on one path only: an optional field is not a way for a stale value to slip in", () => {
    const workflow = gateWorkflow("loose-gate", LoosePublisherAgent);

    expect(messagesOf(workflow, "input.outdated-on-path")).toEqual([expect.stringMatching(stale)]);
    expect(codesOf(workflow)).not.toContain("input.never-produced");
  });

  it("outdated on one path only: a required field fails as missing and as outdated", () => {
    const workflow = gateWorkflow("strict-gate", StrictPublisherAgent);

    expect(messagesOf(workflow, "input.outdated-on-path")).toEqual([expect.stringMatching(stale)]);
    expect(codesOf(workflow)).toContain("input.missing-on-path");
  });
});

// --- an agent with output and without input: built from every current value (rule 8) -------

@WorkflowStart({
  name: "thread-workflow-start",
  description: "A message and a candidate",
  input: { message: WorkflowStartTextDto, profile: CandidateProfileDto },
})
class ThreadWorkflowStart {}

@Agent({
  name: "thread-picker-agent",
  description: "Picks a job from the whole thread",
  prompt: "Pick one.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
  output: JobPickDto,
})
class ThreadPickerAgent {}

@Agent({
  name: "message-picker-agent",
  description: "Picks a job from the message only",
  prompt: "Pick one.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
  input: { message: WorkflowStartTextDto },
  output: JobPickDto,
})
class MessagePickerAgent {}

const pickLoop = (name: string, picker: object): object => {
  @Router({
    name: `${name}-router`,
    description: "Picks again, corrects the profile, or stops",
    decidedBy: DecidedBy.Model,
    model: "typesafe/jev-1.13",
    maxVisits: 4,
    input: { pick: JobPickDto },
    routes: [
      { target: picker as never, prompt: "Pick again" },
      { target: ProfileEditorAgent, prompt: "Correct the profile, then stop" },
    ],
  })
  class PickRouter {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(ThreadWorkflowStart)
        .returns(WorkflowStartTextDto)
        .returns(CandidateProfileDto)
        .toAgent(picker as never),
      agent(picker as never)
        .returns(JobPickDto)
        .toRouter(PickRouter),
      router(PickRouter).chooseOne(
        route(picker as never),
        route(ProfileEditorAgent).returns(CandidateProfileDto).toFinish(PickWorkflowFinish),
      ),
    ],
  })
  class PickLoopWorkflow {}
  return PickLoopWorkflow;
};

describe("#271 AC7: the value of an agent without input is outdated on any renewal before it", () => {
  it("agent without input in a loop: a corrected profile outdates its pick", () => {
    expect(
      messagesOf(pickLoop("thread-pick", ThreadPickerAgent), "input.outdated-on-path"),
    ).toEqual([
      expect.stringContaining(
        "pick-workflow-finish (JobPickDto) is outdated on the path thread-workflow-start → " +
          "thread-picker-agent → thread-pick-router → profile-editor-agent → pick-workflow-finish " +
          "(built from CandidateProfileDto, replaced by profile-editor-agent)",
      ),
    ]);
  });

  it("an agent that reads only its input is not outdated by what it did not read", () => {
    expect(codesOf(pickLoop("message-pick", MessagePickerAgent))).not.toContain(
      "input.outdated-on-path",
    );
  });
});

// --- every error at once ------------------------------------------------------------------

@Agent({
  name: "loop-reviewer-agent",
  description: "Reviews the draft, without saying what about",
  prompt: "Review it.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
  input: { draft: DraftDto },
  output: oneOf(ApprovalDto, DraftChangesDto),
})
class LoopReviewerAgent {}

@Workflow({
  name: "broken-review-workflow",
  version: "1.0.0",
  flow: [
    start(StoryWorkflowStart).returns(ArticleRequestDto).toAgent(GateWriterAgent),
    agent(GateWriterAgent)
      .returns(DraftDto)
      .toAgent(LoopReviewerAgent)
      .returns(oneOf(ApprovalDto, DraftChangesDto))
      .switch(
        caseOf(DraftChangesDto).toAgent(GateWriterAgent),
        caseOf(ApprovalDto)
          .toAgent(ProfileEditorAgent)
          .returns(ArticleDto)
          .toFinish(StoryWorkflowFinish),
      ),
  ],
})
class BrokenReviewWorkflow {}

describe("#271 AC13: every assembly error at once, with those of #270 and #272", () => {
  it("all errors at once with #270 / #272", () => {
    const thrown = (): unknown => analyseWorkflow(BrokenReviewWorkflow);

    expect(thrown).toThrow(GraphRuleError);
    expect(codesOf(BrokenReviewWorkflow)).toEqual(
      expect.arrayContaining([
        "flow.returns-mismatch", // #272: the profile editor gives CandidateProfileDto
        "input.missing-on-path", // #270: no profile on the path
        "io.ambiguous-cycle", // #271: the reviewer does not say what its answers are about
      ]),
    );
  });
});

// --- nested cycles: a re-plan loop around the review loop -----------------------------------

@Agent({
  name: "outer-planner-agent",
  description: "Plans the article, again after an approval",
  prompt: "Plan it.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
  input: { request: ArticleRequestDto, approval: optional(ApprovalDto) },
  output: PlanDto,
})
class OuterPlannerAgent {}

@Agent({
  name: "plan-draft-agent",
  description: "Writes the first draft of a plan",
  prompt: "Write it.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
  input: { plan: PlanDto },
  output: DraftDto,
})
class PlanDraftAgent {}

@Agent({
  name: "notes-draft-agent",
  description: "Writes the draft, or rewrites it from the notes",
  prompt: "Write it.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 6,
  input: { plan: PlanDto, changes: optional(DraftChangesDto) },
  output: DraftDto,
})
class NotesDraftAgent {}

@Agent({
  name: "rewrite-agent",
  description: "Rewrites the draft from the notes",
  prompt: "Rewrite it.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 6,
  input: { plan: PlanDto, draft: DraftDto, changes: DraftChangesDto },
  output: DraftDto,
})
class RewriteAgent {}

@Agent({
  name: "inner-reviewer-agent",
  description: "Approves the draft or asks for changes",
  prompt: "Review it.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 6,
  input: { draft: DraftDto },
  output: oneOf(ApprovalDto, DraftChangesDto),
})
class InnerReviewerAgent {}

@Router({
  name: "replan-router",
  description: "Plans again or publishes",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  maxVisits: 3,
  input: { approval: ApprovalDto },
  routes: [
    { target: OuterPlannerAgent, prompt: "Plan again" },
    { target: PublisherAgent, prompt: "Stop and publish" },
  ],
})
class ReplanRouter {}

@Workflow({
  name: "one-writer-workflow",
  version: "1.0.0",
  flow: [
    start(StoryWorkflowStart).returns(ArticleRequestDto).toAgent(OuterPlannerAgent),
    agent(OuterPlannerAgent).returns(PlanDto).toAgent(NotesDraftAgent),
    agent(NotesDraftAgent)
      .returns(DraftDto)
      .toAgent(InnerReviewerAgent)
      .returns(oneOf(ApprovalDto, DraftChangesDto))
      .switch(
        caseOf(DraftChangesDto, { about: DraftDto }).toAgent(NotesDraftAgent),
        caseOf(ApprovalDto, { about: DraftDto })
          .toRouter(ReplanRouter)
          .chooseOne(
            route(OuterPlannerAgent),
            route(PublisherAgent).returns(ArticleDto).toFinish(StoryWorkflowFinish),
          ),
      ),
  ],
})
class OneWriterWorkflow {}

@Workflow({
  name: "two-writers-workflow",
  version: "1.0.0",
  flow: [
    start(StoryWorkflowStart).returns(ArticleRequestDto).toAgent(OuterPlannerAgent),
    agent(OuterPlannerAgent)
      .returns(PlanDto)
      .toAgent(PlanDraftAgent)
      .returns(DraftDto)
      .toAgent(InnerReviewerAgent),
    agent(InnerReviewerAgent)
      .returns(oneOf(ApprovalDto, DraftChangesDto))
      .switch(
        caseOf(DraftChangesDto, { about: DraftDto })
          .toAgent(RewriteAgent)
          .returns(DraftDto)
          .toAgent(InnerReviewerAgent),
        caseOf(ApprovalDto, { about: DraftDto })
          .toRouter(ReplanRouter)
          .chooseOne(
            route(OuterPlannerAgent),
            route(PublisherAgent).returns(ArticleDto).toFinish(StoryWorkflowFinish),
          ),
      ),
  ],
})
class TwoWritersWorkflow {}

describe("#271 edge: nested cycles need more than two passes", () => {
  it("nested cycles: after the inner loop the notes are outdated, so one writer cannot read them on a re-plan", () => {
    expect(messagesOf(OneWriterWorkflow, "input.outdated-on-path")).toEqual([
      expect.stringMatching(
        /notes-draft-agent\.changes \(optional\(DraftChangesDto\)\) is outdated on the path .* → replan-router → outer-planner-agent → notes-draft-agent \(about DraftDto, replaced by notes-draft-agent\)/,
      ),
    ]);
  });

  it("nested cycles: a first-draft writer per plan and a rewriter for the notes assemble", () => {
    expect(checkWorkflow(TwoWritersWorkflow)).toMatchObject({ errors: [] });
    expect(new Set(statusesAt(TwoWritersWorkflow, "rewrite-agent", "DraftChangesDto"))).toEqual(
      new Set([SlotStatus.Current]),
    );
    expect(new Set(statusesAt(TwoWritersWorkflow, "publisher-agent", "ApprovalDto"))).toEqual(
      new Set([SlotStatus.Current]),
    );
  });
});
