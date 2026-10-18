import { describe, expect, it } from "vitest";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import { GraphRuleError } from "../../../src/graph/rule-error.js";
import { analyseWorkflow, checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  ShortlistDto,
} from "../fixtures/dtos.js";
import {
  DraftKitAgent,
  DraftKitWorkflowFinish,
  EditKitAgent,
  KitRouter,
  KitWorkflowStart,
  PolishKitAgent,
  ReviewKitAgent,
  SecondKitWorkflowStart,
  SendKitAction,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { agent, caseOf, start } from "../fixtures/paths.js";

/** The graph rules that stay (#272 AC11, AC14): all at once, before any model call. */

const codesOf = (workflow: abstract new () => unknown): readonly string[] =>
  checkWorkflow(workflow).errors.map((found) => found.code);

const reviewPaths = (editor: typeof EditKitAgent | typeof PolishKitAgent) => [
  start(KitWorkflowStart)
    .returns(ShortlistDto)
    .toAgent(DraftKitAgent)
    .returns(OfferDraftDto)
    .toAgent(ReviewKitAgent),
  agent(ReviewKitAgent)
    .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
    .switch(
      caseOf(ChangesRequestedDto).toAgent(editor).returns(OfferDraftDto).toAgent(ReviewKitAgent),
      caseOf(DraftApprovedDto)
        .toAction(SendKitAction)
        .returns(OfferSentDto)
        .toFinish(SentKitWorkflowFinish),
    ),
];

@Workflow({ name: "bounded-loop-workflow", version: "1.0.0", flow: reviewPaths(EditKitAgent) })
class BoundedLoopWorkflow {}

@Workflow({ name: "unbounded-loop-workflow", version: "1.0.0", flow: reviewPaths(PolishKitAgent) })
class UnboundedLoopWorkflow {}

@Workflow({
  name: "two-entry-cycle-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(OfferDraftDto)
      .toAgent(ReviewKitAgent),
    start(SecondKitWorkflowStart).returns(OfferDraftDto).toAgent(EditKitAgent),
    agent(ReviewKitAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(
        caseOf(ChangesRequestedDto).toAgent(EditKitAgent),
        caseOf(DraftApprovedDto)
          .toAction(SendKitAction)
          .returns(OfferSentDto)
          .toFinish(SentKitWorkflowFinish),
      ),
    agent(EditKitAgent).returns(OfferDraftDto).toAgent(ReviewKitAgent),
  ],
})
class TwoEntryCycleWorkflow {}

@Workflow({
  name: "broken-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(OfferDraftDto)
      .toAgent(ReviewKitAgent),
    agent(ReviewKitAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(
        caseOf(ChangesRequestedDto)
          .toAgent(PolishKitAgent)
          .returns(OfferDraftDto)
          .toAgent(ReviewKitAgent),
        caseOf(DraftApprovedDto).toAction(SendKitAction),
      ),
    agent(EditKitAgent)
      .returns(OfferDraftDto)
      .toFinish(DraftKitWorkflowFinish)
      .toFinish(DraftKitWorkflowFinish),
  ],
})
class BrokenWorkflow {}

@Workflow({
  name: "startless-workflow",
  version: "1.0.0",
  flow: [agent(DraftKitAgent).returns(OfferDraftDto).toFinish(DraftKitWorkflowFinish)],
})
class StartlessWorkflow {}

class UndecoratedAgent {
  readonly note = "no decorator";
}

@Workflow({
  name: "wrong-kinds-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart).returns(ShortlistDto).toAgent(KitRouter),
    start(SecondKitWorkflowStart).returns(OfferDraftDto).toAgent(UndecoratedAgent),
  ],
})
class WrongKindsWorkflow {}

@Agent({
  name: "draft-kit-agent",
  description: "A second class under a taken name",
  prompt: "Draft it.",
  model: "moonshotai/kimi-k2.6",
  input: {
    draft: OfferDraftDto,
  },
  output: OfferDraftDto,
})
class SameNameAgent {}

@Workflow({
  name: "same-name-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(OfferDraftDto)
      .toAgent(SameNameAgent),
  ],
})
class SameNameWorkflow {}

describe("AC11: assembly reports all errors at once, before any model call", () => {
  it("throws one GraphRuleError listing every violation", () => {
    const { errors } = checkWorkflow(BrokenWorkflow);

    expect(() => analyseWorkflow(BrokenWorkflow)).toThrow(GraphRuleError);
    expect(() => analyseWorkflow(BrokenWorkflow)).toThrow(
      `The workflow's flow breaks ${String(errors.length)} rule(s)`,
    );
    expect(new Set(codesOf(BrokenWorkflow))).toEqual(
      new Set([
        "graph.cycle-without-max-visits",
        "graph.dead-end",
        "graph.next-after-workflow-finish",
        "graph.unreachable-node",
      ]),
    );
  });

  it("names the unreachable node, the dead end and the step after a finish", () => {
    const messages = checkWorkflow(BrokenWorkflow).errors.map((found) => found.message);

    expect(messages).toEqual(
      expect.arrayContaining([
        "broken-workflow: edit-kit-agent is not reachable from any workflow start — lead a path to it, or remove it from the flow",
        "broken-workflow: the path stops at send-kit-action — continue it with .to…(…), or end it with .toFinish(…); every path ends in a finish or at a shared node",
        "broken-workflow: draft-kit-workflow-finish is a finish — nothing follows .toFinish(…) or route(…) of a finish",
      ]),
    );
  });

  it("a cycle without maxVisits on any of its nodes fails", () => {
    expect(checkWorkflow(UnboundedLoopWorkflow).errors).toEqual([
      expect.objectContaining({
        code: "graph.cycle-without-max-visits",
        message:
          "unbounded-loop-workflow: the cycle through polish-kit-agent, review-kit-agent has no maxVisits — set maxVisits on one of its agents or routers",
        nodes: ["polish-kit-agent", "review-kit-agent"],
      }),
    ]);
  });

  it("a cycle with maxVisits on one of its agents passes", () => {
    expect(codesOf(BoundedLoopWorkflow)).toEqual([]);
  });

  it("a cycle entered at two different nodes passes", () => {
    expect(codesOf(TwoEntryCycleWorkflow)).toEqual([]);
  });

  it("a flow without a workflow start fails", () => {
    expect(codesOf(StartlessWorkflow)).toEqual(["graph.no-workflow-start"]);
  });

  it("a class of another kind, or without a decorator, is not a node", () => {
    const messages = checkWorkflow(WrongKindsWorkflow).errors.map((found) => found.message);

    expect(messages).toEqual(
      expect.arrayContaining([
        "wrong-kinds-workflow: toAgent(KitRouter): kit-router is a router, not an agent — use toRouter(KitRouter)",
        "wrong-kinds-workflow: toAgent(UndecoratedAgent): UndecoratedAgent has no @WorkflowStart / @Agent / @Action / @Router / @WorkflowFinish decorator — decorate it",
      ]),
    );
  });

  it("two classes under one name fail", () => {
    expect(checkWorkflow(SameNameWorkflow).errors).toContainEqual(
      expect.objectContaining({
        code: "graph.duplicate-node-name",
        message:
          'same-name-workflow: DraftKitAgent and SameNameAgent are both named "draft-kit-agent" — a name is unique in the application (it keys records and checkpoints); rename one',
      }),
    );
  });

  it("a class without @Workflow is not a workflow", () => {
    expect(checkWorkflow(DraftKitAgent)).toEqual({
      errors: [
        expect.objectContaining({
          code: "graph.not-a-node",
          message:
            "DraftKitAgent has no @Workflow decorator — decorate it with @Workflow({ name, version, flow })",
        }),
      ],
      warnings: [],
    });
    expect(() => analyseWorkflow(DraftKitAgent)).toThrow(GraphRuleError);
  });
});
