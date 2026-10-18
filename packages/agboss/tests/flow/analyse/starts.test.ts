import { describe, expect, it } from "vitest";
import {
  analyseWorkflow,
  checkWorkflow,
  inputShapesOf,
} from "../../../src/flow/analyse/analyse.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { listOf, optional } from "../../../src/flow/dto-wrappers.js";
import { OfferDraftDto, ShortlistDto } from "../fixtures/dtos.js";
import { DraftKitWorkflowFinish } from "../fixtures/kit.fixture.js";
import { start } from "../fixtures/paths.js";

/** A start's input as a list or a map of fields (#270 AC20, AC21). */

@WorkflowStart({
  name: "drafts-workflow-start",
  description: "A batch of drafts",
  input: listOf(OfferDraftDto),
})
class DraftsWorkflowStart {}

@Agent({
  name: "rank-drafts-agent",
  description: "Ranks the drafts",
  prompt: "Rank them.",
  model: "moonshotai/kimi-k2.6",
  input: {
    drafts: listOf(OfferDraftDto),
  },
  output: ShortlistDto,
})
class RankDraftsAgent {}

@WorkflowFinish({
  name: "ranked-workflow-finish",
  description: "The ranking",
  output: ShortlistDto,
})
class RankedWorkflowFinish {}

@Workflow({
  name: "list-start-workflow",
  version: "1.0.0",
  flow: [
    start(DraftsWorkflowStart)
      .returns(listOf(OfferDraftDto))
      .toAgent(RankDraftsAgent)
      .returns(ShortlistDto)
      .toFinish(RankedWorkflowFinish),
  ],
})
class ListStartWorkflow {}

@WorkflowStart({
  name: "redraft-workflow-start",
  description: "A shortlist, with an earlier draft or without",
  input: {
    shortlist: ShortlistDto,
    draft: optional(OfferDraftDto),
  },
})
class RedraftWorkflowStart {}

const readerOf = (
  draft: typeof OfferDraftDto | ReturnType<typeof optional<typeof OfferDraftDto>>,
) => {
  @Agent({
    name: "redraft-agent",
    description: "Drafts again, from the earlier draft when there is one",
    prompt: "Draft it.",
    model: "moonshotai/kimi-k2.6",
    input: {
      shortlist: ShortlistDto,
      draft,
    },
    output: OfferDraftDto,
  })
  class RedraftAgent {}

  @Workflow({
    name: "map-start-workflow",
    version: "1.0.0",
    flow: [
      start(RedraftWorkflowStart)
        .returns(ShortlistDto)
        .returns(optional(OfferDraftDto))
        .toAgent(RedraftAgent)
        .returns(OfferDraftDto)
        .toFinish(DraftKitWorkflowFinish),
    ],
  })
  class MapStartWorkflow {}
  return MapStartWorkflow;
};

describe("#270 AC20: list start", () => {
  it("a start's input may be a list; nodes below read it by shape", () => {
    const analysis = analyseWorkflow(ListStartWorkflow);

    expect(inputShapesOf(analysis, "rank-drafts-agent")).toEqual([
      [{ name: "drafts", isPresent: true, producers: ["drafts-workflow-start"] }],
    ]);
  });
});

describe("#270 AC21: map start", () => {
  it("an optional field of the start narrows by path", () => {
    expect(
      inputShapesOf(analyseWorkflow(readerOf(optional(OfferDraftDto))), "redraft-agent"),
    ).toEqual([
      [
        { name: "shortlist", isPresent: true, producers: ["redraft-workflow-start"] },
        { name: "draft", isPresent: false, producers: [] },
      ],
      [
        { name: "shortlist", isPresent: true, producers: ["redraft-workflow-start"] },
        { name: "draft", isPresent: true, producers: ["redraft-workflow-start"] },
      ],
    ]);
  });

  it("a required field missing on a path fails", () => {
    expect(checkWorkflow(readerOf(OfferDraftDto)).errors).toEqual([
      expect.objectContaining({
        code: "input.missing-on-path",
        message:
          "map-start-workflow: redraft-agent.draft (OfferDraftDto) is not produced on the path redraft-workflow-start → redraft-agent",
      }),
    ]);
  });
});
