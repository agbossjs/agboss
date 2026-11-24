/**
 * #1365, #1373: a `maxVisits: null` (options from untyped code or parsed JSON) is a bound of 0 to both the
 * build-time analysis and the run-time guard: the analysis does not report the cycle it closes as unbounded, the
 * build refuses the value itself (`[limits.count-invalid]`), and a run that got past it refuses the node on its
 * first visit. The two agree, and fail closed.
 */
import { describe, expect, it } from "vitest";
import { BudgetMeter } from "../../../src/budgets/execution-budgets.js";
import { InMemoryCostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import { VirtualClock } from "../../../src/testing/index.js";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import { VisitsLimitExceededError } from "../../../src/flow/runtime/errors.js";
import { runtimeGraphOf } from "../../../src/flow/runtime/graph-model.js";
import { checkVisit, type ExecutionLimits } from "../../../src/flow/runtime/limits.js";
import { ChangesRequestedDto, DraftApprovedDto, OfferDraftDto } from "../fixtures/dtos.js";
import {
  DraftKitAgent,
  KitWorkflowStart,
  SendKitAction,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { onAgent, caseOf, onStart } from "../fixtures/paths.js";

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
    onStart(KitWorkflowStart).toAgent(DraftKitAgent).toAgent(NullBoundReviewAgent),
    onAgent(NullBoundReviewAgent).switch(
      caseOf(ChangesRequestedDto).toAgent(NullBoundEditAgent).toAgent(NullBoundReviewAgent),
      caseOf(DraftApprovedDto).toAction(SendKitAction).toFinish(SentKitWorkflowFinish),
    ),
  ],
})
class NullBoundLoopWorkflow {}

describe("#1365, #1373: maxVisits null, at build time and at run time", () => {
  it("build time: null is a bound, so the cycle it closes is not reported — and the value itself is refused", () => {
    const { errors } = checkWorkflow(NullBoundLoopWorkflow);

    expect(errors.map((found) => found.code)).toEqual(["limits.count-invalid"]);
    expect(errors[0]?.message).toContain("maxVisits is null, not a whole number from 0");
  });

  it("run time: the node the analysis counted as bounded is refused on its first visit", async () => {
    const { analysis } = checkWorkflow(NullBoundLoopWorkflow);
    if (analysis === undefined) throw new Error("no analysis");
    const graph = runtimeGraphOf(analysis, [], NullBoundLoopWorkflow);
    const node = graph.nodes.get("null-bound-edit-agent");
    if (node === undefined) throw new Error("no null-bound-edit-agent node");
    const limits: ExecutionLimits = {
      maxSteps: 10,
      budgets: new BudgetMeter(
        [],
        new InMemoryCostLedgerRepository(),
        new VirtualClock(new Date("2026-11-04T12:00:00.000Z")),
        0,
      ),
    };
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
