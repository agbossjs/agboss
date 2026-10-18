import { describe, expect, it } from "vitest";
import {
  analyseWorkflow,
  checkWorkflow,
  inputShapesOf,
} from "../../../src/flow/analyse/analyse.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { historyOf } from "../../../src/flow/dto-wrappers.js";
import { DraftChangesDto } from "../fixtures/data-dtos.js";
import { OfferDraftDto, ShortlistDto } from "../fixtures/dtos.js";
import {
  DraftHistoryWorkflowFinish,
  FirstDraftAgent,
  HistoryOfferWorkflow,
  HistoryOfferWorkflowStart,
} from "../fixtures/history.fixture.js";
import { start } from "../fixtures/paths.js";
import { ResearchDto } from "../fixtures/review-dtos.js";

/**
 * #299 S56 (AC4, analysis): `historyOf(XDto)` needs a current `XDto` on every path into its node;
 * the earlier versions on the path are its `previous` — never `[input.outdated-on-path]`.
 */

const errorsOf = (workflow: abstract new () => unknown, code: string): readonly string[] =>
  checkWorkflow(workflow)
    .errors.filter((found) => found.code === code)
    .map((found) => found.message);

@Agent({
  name: "draft-history-agent",
  description: "Reads the drafts so far",
  prompt: "Compare the drafts.",
  model: "moonshotai/kimi-k2.6",
  input: { drafts: historyOf(OfferDraftDto, { limit: 2 }) },
  output: DraftChangesDto,
})
class DraftHistoryAgent {}

@Workflow({
  name: "no-draft-workflow",
  version: "1.0.0",
  flow: [
    start(HistoryOfferWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftHistoryAgent)
      .returns(DraftChangesDto)
      .toFinish(DraftHistoryWorkflowFinish),
  ],
})
class NoDraftWorkflow {}

/** A draft built from research, then the research renewed: the latest draft is outdated. */
@Agent({
  name: "research-agent",
  description: "Researches",
  prompt: "Research.",
  model: "moonshotai/kimi-k2.6",
  input: { shortlist: ShortlistDto },
  output: ResearchDto,
})
class ResearchAgent {}

@Agent({
  name: "research-draft-agent",
  description: "Drafts from the research",
  prompt: "Draft.",
  model: "moonshotai/kimi-k2.6",
  input: { research: ResearchDto },
  output: OfferDraftDto,
})
class ResearchDraftAgent {}

@Agent({
  name: "research-again-agent",
  description: "Researches again",
  prompt: "Research again.",
  model: "moonshotai/kimi-k2.6",
  input: { shortlist: ShortlistDto },
  output: ResearchDto,
})
class ResearchAgainAgent {}

@Workflow({
  name: "stale-draft-workflow",
  version: "1.0.0",
  flow: [
    start(HistoryOfferWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(ResearchAgent)
      .returns(ResearchDto)
      .toAgent(ResearchDraftAgent)
      .returns(OfferDraftDto)
      .toAgent(ResearchAgainAgent)
      .returns(ResearchDto)
      .toAgent(DraftHistoryAgent)
      .returns(DraftChangesDto)
      .toFinish(DraftHistoryWorkflowFinish),
  ],
})
class StaleDraftWorkflow {}

@Agent({
  name: "limitless-agent",
  description: "A history with a limit that is not one",
  prompt: "Read.",
  model: "moonshotai/kimi-k2.6",
  input: { drafts: historyOf(OfferDraftDto, { limit: 0 }) },
  output: DraftChangesDto,
})
class LimitlessAgent {}

@Workflow({
  name: "bad-limit-workflow",
  version: "1.0.0",
  flow: [
    start(HistoryOfferWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(FirstDraftAgent)
      .returns(OfferDraftDto)
      .toAgent(LimitlessAgent)
      .returns(DraftChangesDto)
      .toFinish(DraftHistoryWorkflowFinish),
  ],
})
class BadLimitWorkflow {}

describe("#299 AC4: historyOf(Dto) in the analysis", () => {
  it("the review loop assembles: replaced drafts are the history's previous, not outdated reads", () => {
    expect(checkWorkflow(HistoryOfferWorkflow)).toMatchObject({ errors: [], warnings: [] });
    expect(inputShapesOf(analyseWorkflow(HistoryOfferWorkflow), "review-draft-action")).toEqual([
      [{ name: "draft", isPresent: true, producers: ["draft-editor-agent"] }],
      [{ name: "draft", isPresent: true, producers: ["first-draft-agent"] }],
    ]);
  });

  it("without a current Dto on the path → [input.missing-on-path]", () => {
    expect(errorsOf(NoDraftWorkflow, "input.missing-on-path")).toContain(
      "no-draft-workflow: draft-history-agent.drafts (historyOf(OfferDraftDto, { limit: 2 })) is not produced on the path history-offer-workflow-start → draft-history-agent",
    );
  });

  it("a latest Dto that is outdated is no current one: [input.missing-on-path], not outdated-on-path", () => {
    expect(errorsOf(StaleDraftWorkflow, "input.missing-on-path")).toContain(
      "stale-draft-workflow: draft-history-agent.drafts (historyOf(OfferDraftDto, { limit: 2 })) has no current OfferDraftDto on the path history-offer-workflow-start → research-agent → research-draft-agent → research-again-agent → draft-history-agent — the latest one is outdated; renew it on that path before draft-history-agent",
    );
    expect(errorsOf(StaleDraftWorkflow, "input.outdated-on-path")).toEqual([]);
  });

  it("a limit that is not a positive integer → [input.history-limit]", () => {
    expect(errorsOf(BadLimitWorkflow, "input.history-limit")).toEqual([
      "bad-limit-workflow: limitless-agent.drafts (historyOf(OfferDraftDto, { limit: 0 })): limit 0 — historyOf(…, { limit }) takes a positive integer, or no limit for every earlier version",
    ]);
  });
});
