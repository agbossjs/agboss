import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { StepKind } from "../../../src/flow/ast.js";
import { EdgeKind } from "../../../src/flow/analyse/flow-graph.js";
import { walkFlow } from "../../../src/flow/analyse/walk.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { oneOf, optional } from "../../../src/flow/dto-wrappers.js";
import { pathLines } from "../../../src/flow/print.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  ResumeMissingDto,
} from "../fixtures/dtos.js";
import {
  DraftKitAgent,
  DraftKitWorkflowFinish,
  KitWorkflowStart,
  NotifyKitAction,
  ReviewKitAgent,
  SendKitAction,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { onStart, side, toAction, toAgent, toFinish } from "../fixtures/paths.js";
import { inline, Ttl } from "../../../src/index.js";

/**
 * `.toOneOf([…branches])` names no DTO: each branch takes the variant its entry consumer reads,
 * the one left to the one branch that reads none (#1275a).
 */

@Agent({
  name: "changes-edit-agent",
  description: "Edits the draft by the reviewer's notes",
  prompt: inline("Edit it."),
  model: "moonshotai/kimi-k2.6",
  input: { changes: ChangesRequestedDto, draft: OfferDraftDto },
  output: OfferDraftDto,
})
class ChangesEditAgent {}

@Agent({
  name: "second-edit-agent",
  description: "Edits the draft too",
  prompt: inline("Edit it."),
  model: "moonshotai/kimi-k2.6",
  input: { changes: ChangesRequestedDto },
  output: OfferDraftDto,
})
class SecondEditAgent {}

@Action({
  name: "approved-send-action",
  description: "Sends the approved offer",
  input: { approved: DraftApprovedDto, draft: OfferDraftDto },
  output: OfferSentDto,
})
class ApprovedSendAction {
  async execute(): Promise<OfferSentDto> {
    return Promise.resolve({ delivered: true });
  }
}

@Action({
  name: "ping-kit-action",
  description: "Pings, reads nothing",
})
class PingKitAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({
  name: "both-kit-action",
  description: "Reads both variants",
  input: { changes: optional(ChangesRequestedDto), approved: optional(DraftApprovedDto) },
})
class BothKitAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Agent({
  name: "triage-kit-agent",
  description: "Three outcomes",
  prompt: inline("Triage it."),
  model: "moonshotai/kimi-k2.6",
  input: { draft: OfferDraftDto },
  output: oneOf(ChangesRequestedDto, DraftApprovedDto, ResumeMissingDto),
})
class TriageKitAgent {}

@WorkflowFinish({
  name: "missing-kit-workflow-finish",
  description: "No resume",
  output: ResumeMissingDto,
})
class MissingKitWorkflowFinish {}

const reviewed = () => onStart(KitWorkflowStart).toAgent(DraftKitAgent).toAgent(ReviewKitAgent);

const edits = () => toAgent(ChangesEditAgent).toFinish(DraftKitWorkflowFinish);
const sends = () => toAction(ApprovedSendAction).toFinish(SentKitWorkflowFinish);

const check = (flow: ReturnType<typeof reviewed>[], name: string) => {
  @Workflow({ name, version: "1.0.0", historyTtl: Ttl.Forever, flow })
  class Checked {}
  return checkWorkflow(Checked);
};

describe("variants by the entry consumer", () => {
  it("each branch reads its variant: no errors, in any order", () => {
    expect(check([reviewed().toOneOf([edits(), sends()])], "one-of-ab-workflow").errors).toEqual(
      [],
    );
    expect(check([reviewed().toOneOf([sends(), edits()])], "one-of-ba-workflow").errors).toEqual(
      [],
    );
  });

  it("the write of each branch's first edge is the variant it read", () => {
    const flow = [reviewed().toOneOf([sends(), edits()])];
    const writes = walkFlow(flow.map((path) => ({ source: path.source, steps: path.steps })))
      .graph.edges.filter((edge) => edge.kind === EdgeKind.Case)
      .map((edge) => [edge.to, edge.writes.map((write) => [write.shape, write.isCase])]);
    expect(writes).toEqual([
      ["approved-send-action", [[DraftApprovedDto, true]]],
      ["changes-edit-agent", [[ChangesRequestedDto, true]]],
    ]);
  });

  it("N-1: the one branch that reads no variant takes the variant left", () => {
    const fallback = () => toAction(SendKitAction).toFinish(SentKitWorkflowFinish);
    const flow = [reviewed().toOneOf([edits(), fallback()])];
    expect(check(flow, "one-of-fallback-workflow").errors).toEqual([]);
    const edges = walkFlow(flow.map((path) => ({ source: path.source, steps: path.steps })))
      .graph.edges.filter((edge) => edge.to === "send-kit-action")
      .map((edge) => edge.writes.map((write) => write.shape));
    expect(edges).toEqual([[DraftApprovedDto]]);
  });

  it("leading actions that read nothing are skipped", () => {
    const ping = () => toAction(PingKitAction).toAction(ApprovedSendAction);
    const flow = [reviewed().toOneOf([edits(), ping().toFinish(SentKitWorkflowFinish)])];
    expect(check(flow, "one-of-ping-workflow").errors).toEqual([]);
  });

  it("a finish reads its output: a finish branch takes its variant", () => {
    const flow = [
      onStart(KitWorkflowStart)
        .toAgent(DraftKitAgent)
        .toAgent(TriageKitAgent)
        .toOneOf([edits(), sends(), toFinish(MissingKitWorkflowFinish)]),
    ];
    expect(check(flow, "one-of-finish-workflow").errors).toEqual([]);
  });
});

describe("what a .toOneOf([…]) refuses", () => {
  it("a variant no branch reads is not exhaustive, naming it", () => {
    const flow = [
      onStart(KitWorkflowStart)
        .toAgent(DraftKitAgent)
        .toAgent(TriageKitAgent)
        .toOneOf([edits(), sends()]),
    ];
    expect(check(flow, "one-of-missing-workflow").errors).toEqual([
      expect.objectContaining({
        code: "flow.one-of-not-exhaustive",
        message:
          "one-of-missing-workflow: triage-kit-agent gives oneOf(ChangesRequestedDto, DraftApprovedDto, ResumeMissingDto): no branch reads ResumeMissingDto — add one whose first step takes it as input",
      }),
    ]);
  });

  it("two branches reading one variant are ambiguous", () => {
    const twice = () => toAgent(SecondEditAgent).toFinish(DraftKitWorkflowFinish);
    const found = check([reviewed().toOneOf([edits(), twice()])], "one-of-twice-workflow");
    expect(found.errors).toContainEqual(
      expect.objectContaining({
        code: "flow.one-of-ambiguous",
        message:
          "one-of-twice-workflow: review-kit-agent gives oneOf(ChangesRequestedDto, DraftApprovedDto): toAgent(ChangesEditAgent) and toAgent(SecondEditAgent) both read ChangesRequestedDto — a variant has one branch",
      }),
    );
    expect(found.errors).toContainEqual(
      expect.objectContaining({ code: "flow.one-of-not-exhaustive" }),
    );
  });

  it("a branch reading two variants is ambiguous", () => {
    const flow = [
      reviewed().toOneOf([toAction(BothKitAction).toFinish(SentKitWorkflowFinish), sends()]),
    ];
    expect(check(flow, "one-of-both-workflow").errors).toContainEqual(
      expect.objectContaining({
        code: "flow.one-of-ambiguous",
        message:
          "one-of-both-workflow: review-kit-agent gives oneOf(ChangesRequestedDto, DraftApprovedDto): toAction(BothKitAction) reads ChangesRequestedDto and DraftApprovedDto, variants of one oneOf — a branch takes exactly one",
      }),
    );
  });

  it("two branches reading no variant are ambiguous: only one may take the variant left", () => {
    const fallback = () => toAction(SendKitAction).toFinish(SentKitWorkflowFinish);
    const other = () => toAction(NotifyKitAction).toFinish(SentKitWorkflowFinish);
    const found = check([reviewed().toOneOf([fallback(), other()])], "one-of-loose-workflow");
    const ambiguous = found.errors.filter((error) => error.code === "flow.one-of-ambiguous");
    expect(ambiguous.map((error) => error.message).sort()).toEqual([
      expect.stringContaining("toAction(NotifyKitAction) reads no variant"),
      expect.stringContaining("toAction(SendKitAction) reads no variant"),
    ]);
  });

  it("a branch reading no variant with no variant left is ambiguous", () => {
    const flow = [
      reviewed().toOneOf([
        edits(),
        sends(),
        toAction(SendKitAction).toFinish(SentKitWorkflowFinish),
      ]),
    ];
    expect(check(flow, "one-of-extra-workflow").errors).toEqual([
      expect.objectContaining({
        code: "flow.one-of-ambiguous",
        message: expect.stringContaining(
          "toAction(SendKitAction) reads no variant and no variant is left",
        ),
      }),
    ]);
  });

  it("a .toOneOf([…]) after a step without a oneOf output fails", () => {
    const flow = [onStart(KitWorkflowStart).toAgent(DraftKitAgent).toOneOf([edits(), sends()])];
    expect(check(flow, "one-of-plain-workflow").errors).toContainEqual(
      expect.objectContaining({
        code: "flow.one-of-ambiguous",
        message:
          "one-of-plain-workflow: draft-kit-agent gives OfferDraftDto, not a oneOf — .toOneOf([…]) follows a step with a oneOf output; continue with .to…(…) after it instead",
      }),
    );
  });

  it("a transition right after a oneOf output, without .toOneOf, is not exhaustive", () => {
    const flow = [reviewed().toAction(SendKitAction).toFinish(SentKitWorkflowFinish)];
    expect(check(flow, "one-of-unbranched-workflow").errors).toContainEqual(
      expect.objectContaining({
        code: "flow.one-of-not-exhaustive",
        message:
          "one-of-unbranched-workflow: review-kit-agent gives oneOf(ChangesRequestedDto, DraftApprovedDto) — branch it with .toOneOf([…])",
      }),
    );
  });

  it("a branch that leads nowhere is a dead end", () => {
    const flow = [reviewed().toOneOf([edits(), side()])];
    expect(check(flow, "one-of-dead-end-workflow").errors).toContainEqual(
      expect.objectContaining({
        code: "graph.dead-end",
        message:
          "one-of-dead-end-workflow: review-kit-agent: a .toOneOf([…]) branch leads nowhere — continue it with .to…(…)",
      }),
    );
  });
});

describe("the AST and its print", () => {
  it("a .toOneOf holds its side paths in order", () => {
    const path = reviewed().toOneOf([sends(), edits()]);
    expect(path.steps.at(-1)).toMatchObject({ kind: StepKind.OneOf });
    expect(pathLines({ source: path.source, steps: path.steps })).toEqual([
      "onStart(KitWorkflowStart)",
      "  .toAgent(DraftKitAgent)",
      "  .toAgent(ReviewKitAgent)",
      "  .toOneOf([",
      "    toAction(ApprovedSendAction)",
      "      .toFinish(SentKitWorkflowFinish),",
      "    toAgent(ChangesEditAgent)",
      "      .toFinish(DraftKitWorkflowFinish),",
      "  ])",
    ]);
  });

  it("refuses what is not an array of two side paths", () => {
    expect(() => reviewed().toOneOf(edits())).toThrow("takes an array");
    expect(() => reviewed().toOneOf([edits()])).toThrow("takes an array");
    expect(() => reviewed().toOneOf([edits(), onStart(KitWorkflowStart)])).toThrow(
      "takes side paths",
    );
  });
});
