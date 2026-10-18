import { describe, expect } from "vitest";
import { LimitExceededError, RouterDecisionError, RouterFailedError } from "../../../src/index.js";
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

/** #280 S19: a router that fails (`RouterFailedError`) and one that decides wrongly (`RouterDecisionError`). */

const test = testWith(AskApplication);
const caught = testWith(AskCaughtApplication);
const credit = testWith(CreditApplication);

const ask = (answer: Answer) => ({ answer });

describe("a code router's answer is checked against its routes", () => {
  test("a route it returns is taken", async ({ app }) => {
    const result = await execute(app, AskWorkflowStart, ask("right"));

    expect(result).toFollowPath([AskWorkflowStart, AskRouter, RightAction, DoneWorkflowFinish]);
  });

  test("a class outside its routes (a cast) is RouterDecisionError", async ({ app }) => {
    const run = execute(app, AskWorkflowStart, ask("outside"));

    await expect(run).rejects.toBeInstanceOf(RouterDecisionError);
    await expect(run).rejects.toMatchObject({
      code: "step.router.invalid-decision",
      nodeId: "ask-router",
      visitNumber: 1,
      reason:
        "route() returned done-workflow-finish: not one of its routes (left-action, right-action)",
    });
  });

  test("a list after .chooseOne(…) is RouterDecisionError", async ({ app }) => {
    await expect(execute(app, AskWorkflowStart, ask("list"))).rejects.toMatchObject({
      code: "step.router.invalid-decision",
      reason: "route() returned a list of 1: after .chooseOne(…) it returns one target, not a list",
    });
  });

  test("nothing returned is RouterDecisionError", async ({ app }) => {
    await expect(execute(app, AskWorkflowStart, ask("nothing"))).rejects.toMatchObject({
      reason: "route() returned undefined: not one of its routes (left-action, right-action)",
    });
  });
});

describe("what route() throws", () => {
  test("a domain error is RouterFailedError's cause: .onError(DomainError) takes it", async ({
    app,
  }) => {
    const result = await execute(app, AskWorkflowStart, ask("domain-error"));

    expect(result).toFollowPath([AskWorkflowStart, AskRouter, HeldWorkflowFinish]);
  });

  test("an uncaught throw fails the execution with RouterFailedError, the cause kept", async ({
    app,
  }) => {
    const run = execute(app, AskWorkflowStart, ask("crash"));

    await expect(run).rejects.toBeInstanceOf(RouterFailedError);
    await expect(run).rejects.not.toBeInstanceOf(RouterDecisionError);
    await expect(run).rejects.toMatchObject({
      message: 'Router "ask-router" failed: route() has a bug',
      cause: { name: "TypeError" },
    });
  });

  test("a limit passes as it is, never wrapped", async ({ app }) => {
    const run = execute(app, AskWorkflowStart, ask("limit"));

    await expect(run).rejects.toBeInstanceOf(LimitExceededError);
    await expect(run).rejects.not.toBeInstanceOf(RouterFailedError);
  });
});

describe(".onError(RouterFailedError) takes both: a decision error is a router failure", () => {
  caught("an invalid decision and a crash both go to the side path", async ({ app }) => {
    const invalid = await execute(app, AskWorkflowStart, ask("outside"));
    const crashed = await execute(app, AskWorkflowStart, ask("crash"));

    expect(invalid).toFollowPath([AskWorkflowStart, AskRouter, RefusedWorkflowFinish]);
    expect(crashed).toFollowPath([AskWorkflowStart, AskRouter, RefusedWorkflowFinish]);
  });
});

describe("a model router: a failed call is RouterFailedError (S19)", () => {
  credit(
    "a failed model call is RouterFailedError with the call's error as cause",
    async ({ app, mockLlm }) => {
      mockLlm(DeskRouter).thenReturn(failWith(ModelFailure.Timeout));

      const run = app.execute(CreditWorkflowStart, { text: "tea" });

      await expect(run).rejects.toMatchObject({
        name: "RouterFailedError",
        code: "step.router",
        nodeId: "desk-router",
        cause: { name: "ModelCallFailedError" },
      });
    },
  );
});
