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
  DraftHistoryAction,
} from "../fixtures/history.fixture.js";
import { onStart } from "../fixtures/paths.js";
import { ResearchDto } from "../fixtures/review-dtos.js";
import { inline } from "../../../src/index.js";

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
  prompt: inline("Compare the drafts."),
  model: "moonshotai/kimi-k2.6",
  input: { drafts: historyOf(OfferDraftDto, { maxPrevious: 2 }) },
  output: DraftChangesDto,
})
class DraftHistoryAgent {}

@Workflow({
  name: "no-draft-workflow",
  version: "1.0.0",
  flow: [
    onStart(HistoryOfferWorkflowStart)
      .toAgent(DraftHistoryAgent)
      .toAction(DraftHistoryAction)
      .toFinish(DraftHistoryWorkflowFinish),
  ],
})
class NoDraftWorkflow {}

/** A draft built from research, then the research renewed: the latest draft is outdated. */
@Agent({
  name: "research-agent",
  description: "Researches",
  prompt: inline("Research."),
  model: "moonshotai/kimi-k2.6",
  input: { shortlist: ShortlistDto },
  output: ResearchDto,
})
class ResearchAgent {}

@Agent({
  name: "research-draft-agent",
  description: "Drafts from the research",
  prompt: inline("Draft."),
  model: "moonshotai/kimi-k2.6",
  input: { research: ResearchDto },
  output: OfferDraftDto,
})
class ResearchDraftAgent {}

@Agent({
  name: "research-again-agent",
  description: "Researches again",
  prompt: inline("Research again."),
  model: "moonshotai/kimi-k2.6",
  input: { shortlist: ShortlistDto },
  output: ResearchDto,
})
class ResearchAgainAgent {}

@Workflow({
  name: "stale-draft-workflow",
  version: "1.0.0",
  flow: [
    onStart(HistoryOfferWorkflowStart)
      .toAgent(ResearchAgent)
      .toAgent(ResearchDraftAgent)
      .toAgent(ResearchAgainAgent)
      .toAgent(DraftHistoryAgent)
      .toAction(DraftHistoryAction)
      .toFinish(DraftHistoryWorkflowFinish),
  ],
})
class StaleDraftWorkflow {}

@Agent({
  name: "limitless-agent",
  description: "A history with a maxPrevious that is not one",
  prompt: inline("Read."),
  model: "moonshotai/kimi-k2.6",
  input: { drafts: historyOf(OfferDraftDto, { maxPrevious: 0 }) },
  output: DraftChangesDto,
})
class LimitlessAgent {}

@Workflow({
  name: "bad-limit-workflow",
  version: "1.0.0",
  flow: [
    onStart(HistoryOfferWorkflowStart)
      .toAgent(FirstDraftAgent)
      .toAgent(LimitlessAgent)
      .toAction(DraftHistoryAction)
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
      "no-draft-workflow: draft-history-agent.drafts (historyOf(OfferDraftDto, { maxPrevious: 2 })) is not produced on the path history-offer-workflow-start → draft-history-agent",
    );
  });

  it("a latest Dto that is outdated is no current one: [input.missing-on-path], not outdated-on-path", () => {
    expect(errorsOf(StaleDraftWorkflow, "input.missing-on-path")).toContain(
      "stale-draft-workflow: draft-history-agent.drafts (historyOf(OfferDraftDto, { maxPrevious: 2 })) has no current OfferDraftDto on the path history-offer-workflow-start → research-agent → research-draft-agent → research-again-agent → draft-history-agent — the latest one is outdated; renew it on that path before draft-history-agent",
    );
    expect(errorsOf(StaleDraftWorkflow, "input.outdated-on-path")).toEqual([]);
  });

  it("a maxPrevious that is not a positive integer → [input.history-max-previous]", () => {
    expect(errorsOf(BadLimitWorkflow, "input.history-max-previous")).toEqual([
      "bad-limit-workflow: limitless-agent.drafts (historyOf(OfferDraftDto, { maxPrevious: 0 })): maxPrevious 0 — historyOf(…, { maxPrevious }) takes a positive integer, or no maxPrevious for every earlier version",
    ]);
  });
});
