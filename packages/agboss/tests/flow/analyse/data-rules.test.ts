import { describe, expect, it } from "vitest";
import {
  analyseWorkflow,
  checkWorkflow,
  inputShapesOf,
} from "../../../src/flow/analyse/analyse.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { listOf, optional } from "../../../src/flow/dto-wrappers.js";
import { OfferDraftDto, OfferSentDto, ShortlistDto, UnrelatedDto } from "../fixtures/dtos.js";
import {
  DraftKitAgent,
  DraftKitWorkflowFinish,
  KitWorkflowStart,
  SendKitAction,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { onAction, route, onStart } from "../fixtures/paths.js";
import { OfferWorkflow } from "../fixtures/offer.fixture.js";

/** The data rules of #270 (AC7, AC19, AC22) on the abstract scopes. */

@Agent({
  name: "needs-unrelated-agent",
  description: "Reads what no path gives",
  prompt: "Read it.",
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
    unrelated: UnrelatedDto,
    maybe: optional(OfferSentDto),
  },
  output: OfferDraftDto,
})
class NeedsUnrelatedAgent {}

@Workflow({
  name: "missing-workflow",
  version: "1.0.0",
  flow: [onStart(KitWorkflowStart).toAgent(NeedsUnrelatedAgent).toFinish(DraftKitWorkflowFinish)],
})
class MissingWorkflow {}

@Agent({
  name: "redraft-kit-agent",
  description: "Drafts again from the shortlist, ignoring the draft",
  prompt: "Draft it again.",
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: OfferDraftDto,
})
class RedraftKitAgent {}

@Workflow({
  name: "dead-store-workflow",
  version: "1.0.0",
  flow: [
    onStart(KitWorkflowStart)
      .toAgent(DraftKitAgent)
      .toAgent(RedraftKitAgent)
      .toFinish(DraftKitWorkflowFinish),
  ],
})
class DeadStoreWorkflow {}

@Router({
  name: "branch-router",
  description: "Sends the draft, or drafts it again",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  input: {
    shortlist: ShortlistDto,
  },
  routes: [
    { target: SendKitAction, prompt: "The draft is good" },
    { target: RedraftKitAgent, prompt: "Start over" },
  ],
})
class BranchRouter {}

@Workflow({
  name: "read-on-one-branch-workflow",
  version: "1.0.0",
  flow: [
    onStart(KitWorkflowStart)
      .toAgent(DraftKitAgent)
      .toRouter(BranchRouter)
      .chooseOne(
        route(SendKitAction).toFinish(SentKitWorkflowFinish),
        route(RedraftKitAgent).toFinish(DraftKitWorkflowFinish),
      ),
  ],
})
class ReadOnOneBranchWorkflow {}

@Agent({
  name: "drafts-agent",
  description: "Drafts several offers",
  prompt: "Draft them.",
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: listOf(OfferDraftDto),
})
class DraftsAgent {}

@Action({
  name: "collect-drafts-action",
  description: "Collects the drafts, when there are any",
  input: {
    drafts: optional(listOf(OfferDraftDto)),
  },
})
class CollectDraftsAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Router({
  name: "drafts-router",
  description: "Drafts several offers or none",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  input: {
    shortlist: ShortlistDto,
  },
  routes: [
    { target: DraftsAgent, prompt: "Draft several" },
    { target: CollectDraftsAction, prompt: "Nothing to draft" },
  ],
})
class DraftsRouter {}

@WorkflowFinish({
  name: "shortlist-kit-workflow-finish",
  description: "The shortlist, as it came",
  output: ShortlistDto,
})
class ShortlistKitWorkflowFinish {}

@Workflow({
  name: "optional-list-workflow",
  version: "1.0.0",
  flow: [
    onStart(KitWorkflowStart)
      .toRouter(DraftsRouter)
      .chooseOne(route(DraftsAgent).toAction(CollectDraftsAction), route(CollectDraftsAction)),
    onAction(CollectDraftsAction).toFinish(ShortlistKitWorkflowFinish),
  ],
})
class OptionalListWorkflow {}

@Workflow({
  name: "no-list-workflow",
  version: "1.0.0",
  flow: [onStart(KitWorkflowStart).toAction(CollectDraftsAction).toFinish(DraftKitWorkflowFinish)],
})
class NoListWorkflow {}

const errorsOf = (workflow: abstract new () => unknown) =>
  checkWorkflow(workflow).errors.map(({ code, message }) => ({ code, message }));

describe("#270 AC7: missing on path, never produced, unused output incl. dead store", () => {
  it("a required field no path brings fails, naming the path; an optional one, too", () => {
    expect(errorsOf(MissingWorkflow)).toEqual([
      {
        code: "input.missing-on-path",
        message:
          "missing-workflow: needs-unrelated-agent.unrelated (UnrelatedDto) is not produced on the path kit-workflow-start → needs-unrelated-agent",
      },
      {
        code: "input.never-produced",
        message:
          "missing-workflow: needs-unrelated-agent.maybe (optional(OfferSentDto)) is optional, but no path into needs-unrelated-agent produces it — return OfferSentDto on a path into needs-unrelated-agent, or remove the field",
      },
    ]);
  });

  it("a dead store fails: the value reaches no reader before it is overwritten", () => {
    expect(errorsOf(DeadStoreWorkflow)).toEqual([
      {
        code: "flow.unused-output",
        message:
          "dead-store-workflow: draft-kit-agent returns OfferDraftDto that no node reads — read it in a node below, or remove it",
      },
    ]);
  });

  it("a value read on one path and overwritten unread on another passes", () => {
    expect(errorsOf(ReadOnOneBranchWorkflow)).toEqual([]);
  });
});

describe("#270 AC19: caseOf reads, void action", () => {
  it("caseOf counts as a read: a marker case needs no field, an action without output no .returns", () => {
    expect(errorsOf(OfferWorkflow)).toEqual([]);
  });
});

describe("#270 AC22: optional list", () => {
  it("optional(listOf(XDto)) is absent on a path without the list and narrows by path", () => {
    expect(errorsOf(OptionalListWorkflow)).toEqual([]);
    expect(inputShapesOf(analyseWorkflow(OptionalListWorkflow), "collect-drafts-action")).toEqual([
      [{ name: "drafts", isPresent: false, producers: [] }],
      [{ name: "drafts", isPresent: true, producers: ["drafts-agent"] }],
    ]);
  });

  it("an optional list no path brings is never produced", () => {
    expect(errorsOf(NoListWorkflow)).toContainEqual({
      code: "input.never-produced",
      message:
        "no-list-workflow: collect-drafts-action.drafts (optional(listOf(OfferDraftDto))) is optional, but no path into collect-drafts-action produces it — return listOf(OfferDraftDto) on a path into collect-drafts-action, or remove the field",
    });
  });
});
