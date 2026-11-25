import { StepError } from "../../../src/core/error-families/step-errors.js";
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import { describe, expect } from "vitest";
import { failWith, ModelFailure, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { CreditWorkflowStart, DeskRouter, CreditApplication } from "../fixtures/credit.fixture.js";
import {
  AskRouter,
  AskWorkflowStart,
  DoneWorkflowFinish,
  HeldWorkflowFinish,
  RefusedWorkflowFinish,
  RightAction,
  type Answer,
  AskCaughtApplication,
  AskApplication,
} from "./fixtures/answer.workflow.js";

/** #280 S19: a router that fails (`StepError.Router`) and one that decides wrongly (`StepError.RouterDecision`). */

const test = testWith(AskApplication);
const caught = testWith(AskCaughtApplication);
const credit = testWith(CreditApplication);

const ask = (answer: Answer) => ({ answer });

describe("a code router's answer is checked against its routes", () => {
  test("a route it returns is taken", async ({ app }) => {
    const result = await execute(app, AskWorkflowStart, ask("right"));

    expect(result).toFollowPath([AskWorkflowStart, AskRouter, RightAction, DoneWorkflowFinish]);
  });

  test("a class outside its routes (a cast) is StepError.RouterDecision", async ({ app }) => {
    const run = execute(app, AskWorkflowStart, ask("outside"));

    await expect(run).rejects.toBeInstanceOf(StepError.RouterDecision);
    await expect(run).rejects.toMatchObject({
      code: "step.router.invalid-decision",
      nodeId: "ask-router",
      visitNumber: 1,
      reason:
        "route() returned done-workflow-finish: not one of its routes (left-action, right-action)",
    });
  });

  test("a list after .onRoute(…) is StepError.RouterDecision", async ({ app }) => {
    await expect(execute(app, AskWorkflowStart, ask("list"))).rejects.toMatchObject({
      code: "step.router.invalid-decision",
      reason: "route() returned a list of 1: after .onRoute(…) it returns one target, not a list",
    });
  });

  test("nothing returned is StepError.RouterDecision", async ({ app }) => {
    await expect(execute(app, AskWorkflowStart, ask("nothing"))).rejects.toMatchObject({
      reason: "route() returned undefined: not one of its routes (left-action, right-action)",
    });
  });
});

describe("what route() throws", () => {
  test("a domain error is StepError.Router's cause: .onError(DomainError) takes it", async ({
    app,
  }) => {
    const result = await execute(app, AskWorkflowStart, ask("domain-error"));

    expect(result).toFollowPath([AskWorkflowStart, AskRouter, HeldWorkflowFinish]);
  });

  test("an uncaught throw fails the execution with StepError.Router, the cause kept", async ({
    app,
  }) => {
    const run = execute(app, AskWorkflowStart, ask("crash"));

    await expect(run).rejects.toBeInstanceOf(StepError.Router);
    await expect(run).rejects.not.toBeInstanceOf(StepError.RouterDecision);
    await expect(run).rejects.toMatchObject({
      message: 'Router "ask-router" failed: route() has a bug',
      cause: { name: "TypeError" },
    });
  });

  test("a limit passes as it is, never wrapped", async ({ app }) => {
    const run = execute(app, AskWorkflowStart, ask("limit"));

    await expect(run).rejects.toBeInstanceOf(LimitError);
    await expect(run).rejects.not.toBeInstanceOf(StepError.Router);
  });
});

describe(".onError(StepError) takes both a router failure and a wrong decision", () => {
  caught("an invalid decision and a crash both go to the side path", async ({ app }) => {
    const invalid = await execute(app, AskWorkflowStart, ask("outside"));
    const crashed = await execute(app, AskWorkflowStart, ask("crash"));

    expect(invalid).toFollowPath([AskWorkflowStart, AskRouter, RefusedWorkflowFinish]);
    expect(crashed).toFollowPath([AskWorkflowStart, AskRouter, RefusedWorkflowFinish]);
  });
});

describe("a model router: a failed call is StepError.Router (S19)", () => {
  credit(
    "a failed model call is StepError.Router with the call's error as cause",
    async ({ app, mockModel }) => {
      mockModel(DeskRouter).thenReturn(failWith(ModelFailure.Timeout));

      const run = app.execute(CreditWorkflowStart, { text: "tea" });

      await expect(run).rejects.toMatchObject({
        name: "StepError.Router",
        code: "step.router",
        nodeId: "desk-router",
        cause: { name: "ModelCallFailedError" },
      });
    },
  );
});
