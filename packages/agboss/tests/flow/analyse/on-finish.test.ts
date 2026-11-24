import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { walkFlow } from "../../../src/flow/analyse/walk.js";
import { EdgeKind } from "../../../src/flow/analyse/flow-graph.js";
import { StepKind } from "../../../src/flow/ast.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { pathLines } from "../../../src/flow/print.js";
import {
  BlockUserAction,
  KycExpiredFinish,
  KycFraudFinish,
  KycVerifiedFinish,
  KycWorkflow,
  OnboardedFinish,
  OnboardStart,
  OpenAccountAction,
  RetryLaterAction,
  TurnedAwayFinish,
} from "../runtime/fixtures/on-finish.workflow.js";
import { onStart, toAction, toFinish } from "../fixtures/paths.js";

/**
 * `.onFinish(ChildFinish, subPath)` names the finish of a child workflow by its class, and covers
 * every finish of it, once each (#1275b).
 */

const verified = () => toAction(OpenAccountAction).toFinish(OnboardedFinish);
const fraud = () => toAction(BlockUserAction).toFinish(TurnedAwayFinish);
const expired = () => toAction(RetryLaterAction).toFinish(TurnedAwayFinish);
const child = () => onStart(OnboardStart).toWorkflow(KycWorkflow);

const check = (flow: ReturnType<typeof child>[], name: string) => {
  @Workflow({ name, version: "1.0.0", flow })
  class Checked {}
  return checkWorkflow(Checked);
};

describe("every finish of the child, once", () => {
  it("passes, in any order", () => {
    const all = child()
      .onFinish(KycExpiredFinish, expired())
      .onFinish(KycVerifiedFinish, verified())
      .onFinish(KycFraudFinish, fraud());
    expect(check([all], "on-finish-all-workflow").errors).toEqual([]);
  });

  it("each branch's first edge carries the finish's output and its component name as key", () => {
    const all = child()
      .onFinish(KycVerifiedFinish, verified())
      .onFinish(KycFraudFinish, fraud())
      .onFinish(KycExpiredFinish, expired());
    const edges = walkFlow([{ source: all.source, steps: all.steps }]).graph.edges.filter(
      (edge) => edge.kind === EdgeKind.Case,
    );
    expect(edges.map((edge) => [edge.to, edge.caseKey])).toEqual([
      ["block-user-action", "kyc-fraud-workflow-finish"],
      ["open-account-action", "kyc-verified-workflow-finish"],
      ["retry-later-action", "kyc-expired-workflow-finish"],
    ]);
  });

  it("a finish left out is not exhaustive, naming it", () => {
    const some = child().onFinish(KycVerifiedFinish, verified()).onFinish(KycFraudFinish, fraud());
    expect(check([some], "on-finish-missing-workflow").errors).toEqual([
      expect.objectContaining({
        code: "flow.one-of-not-exhaustive",
        message:
          "on-finish-missing-workflow: kyc-workflow can end at KycExpiredFinish — add .onFinish(KycExpiredFinish, …)",
      }),
    ]);
  });

  it("a finish written twice is ambiguous", () => {
    const twice = child()
      .onFinish(KycVerifiedFinish, verified())
      .onFinish(KycFraudFinish, fraud())
      .onFinish(KycExpiredFinish, expired())
      .onFinish(KycFraudFinish, fraud());
    expect(check([twice], "on-finish-twice-workflow").errors).toContainEqual(
      expect.objectContaining({
        code: "flow.one-of-ambiguous",
        message: expect.stringContaining(".onFinish(KycFraudFinish, …) is written twice"),
      }),
    );
  });

  it("a finish the child does not have is ambiguous", () => {
    const foreign = child()
      .onFinish(KycVerifiedFinish, verified())
      .onFinish(KycFraudFinish, fraud())
      .onFinish(KycExpiredFinish, expired())
      .onFinish(OnboardedFinish, verified());
    expect(check([foreign], "on-finish-foreign-workflow").errors).toContainEqual(
      expect.objectContaining({
        code: "flow.one-of-ambiguous",
        message: expect.stringContaining("OnboardedFinish is no finish of kyc-workflow"),
      }),
    );
  });

  it("with a transition after the same child, it is ambiguous", () => {
    const mixed = child()
      .onFinish(KycVerifiedFinish, verified())
      .onFinish(KycFraudFinish, fraud())
      .onFinish(KycExpiredFinish, expired())
      .toFinish(TurnedAwayFinish);
    expect(check([mixed], "on-finish-mixed-workflow").errors).toContainEqual(
      expect.objectContaining({ code: "flow.one-of-ambiguous" }),
    );
  });

  it("after a step that is no child workflow, it is ambiguous", () => {
    const wrong = onStart(OnboardStart)
      .toAction(OpenAccountAction)
      .onFinish(KycFraudFinish, toFinish(TurnedAwayFinish));
    expect(check([wrong], "on-finish-wrong-workflow").errors).toContainEqual(
      expect.objectContaining({
        code: "flow.one-of-ambiguous",
        message: expect.stringContaining(".onFinish(F, …) follows a child workflow"),
      }),
    );
  });
});

describe("the AST, its print and its refusals", () => {
  it("records the finish class and the side path, and prints them", () => {
    const path = child().onFinish(KycFraudFinish, fraud());
    expect(path.steps.at(-1)).toMatchObject({ kind: StepKind.OnFinish, finish: KycFraudFinish });
    expect(pathLines({ source: path.source, steps: path.steps })).toEqual([
      "onStart(OnboardStart)",
      "  .toWorkflow(KycWorkflow)",
      "  .onFinish(KycFraudFinish, toAction(BlockUserAction)",
      "    .toFinish(TurnedAwayFinish))",
    ]);
  });

  it("refuses a class that is no finish and a path that is no side path", () => {
    expect(() => child().onFinish(BlockUserAction, fraud())).toThrow("takes a @WorkflowFinish");
    expect(() => child().onFinish(KycFraudFinish, onStart(OnboardStart))).toThrow(
      "takes side paths",
    );
  });
});
