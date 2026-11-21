/**
 * #1365: a `maxVisits: null` (options from untyped code or parsed JSON) is a bound to both the build-time
 * analysis and the run-time guard: the analysis does not report the cycle it closes, and the run refuses
 * the node on its first visit. The two agree, and fail closed.
 */
import { describe, expect, it, vi } from "vitest";
import { analyseWorkflow, checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import { VisitsLimitExceededError } from "../../../src/flow/runtime/errors.js";
import { runtimeGraphOf } from "../../../src/flow/runtime/graph-model.js";
import { checkVisit, type ExecutionLimits } from "../../../src/flow/runtime/limits.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  ShortlistDto,
} from "../fixtures/dtos.js";
import {
  DraftKitAgent,
  KitWorkflowStart,
  SendKitAction,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { agent, caseOf, start } from "../fixtures/paths.js";

@Agent({
  name: "null-bound-edit-agent",
  description: "Edits the draft",
  prompt: "Edit it.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: OfferDraftDto },
  output: OfferDraftDto,
  maxVisits: null as never,
})
class NullBoundEditAgent {}

@Agent({
  name: "null-bound-review-agent",
  description: "Reviews the draft",
  prompt: "Review it.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: OfferDraftDto },
  output: oneOf(ChangesRequestedDto, DraftApprovedDto),
})
class NullBoundReviewAgent {}

@Workflow({
  name: "null-bound-loop-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(OfferDraftDto)
      .toAgent(NullBoundReviewAgent),
    agent(NullBoundReviewAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(
        caseOf(ChangesRequestedDto)
          .toAgent(NullBoundEditAgent)
          .returns(OfferDraftDto)
          .toAgent(NullBoundReviewAgent),
        caseOf(DraftApprovedDto)
          .toAction(SendKitAction)
          .returns(OfferSentDto)
          .toFinish(SentKitWorkflowFinish),
      ),
  ],
})
class NullBoundLoopWorkflow {}

describe("#1365: maxVisits null, at build time and at run time", () => {
  it("build time: the analysis counts null as a bound, so the cycle it closes is not reported", () => {
    expect(checkWorkflow(NullBoundLoopWorkflow).errors).toEqual([]);
  });

  it("run time: the node the analysis counted as bounded is refused on its first visit", async () => {
    const graph = runtimeGraphOf(analyseWorkflow(NullBoundLoopWorkflow), [], NullBoundLoopWorkflow);
    const node = graph.nodes.get("null-bound-edit-agent");
    if (node === undefined) throw new Error("no null-bound-edit-agent node");
    const limits = {
      maxSteps: 10,
      budgets: { refresh: vi.fn(() => Promise.resolve()), check: vi.fn(), tally: vi.fn() },
    } as never as ExecutionLimits;
    const state = {
      path: ["start"],
      usage: [],
      visits: {},
      steps: 0,
      startedVersion: "",
      sidePath: null,
      compensations: [],
    } as never;

    expect(node.maxVisits).toBeNull();
    await expect(
      checkVisit(
        state,
        node,
        limits,
        { name: "w", version: "1", configHash: "h" } as never,
        { name: "n", kind: "agent", promptHash: "p", schemaHash: "s" } as never,
      ),
    ).rejects.toBeInstanceOf(VisitsLimitExceededError);
  });
});
