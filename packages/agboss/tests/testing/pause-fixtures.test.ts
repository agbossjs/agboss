/**
 * #1328d: `answerPause` and `replyToPause` of a test's fixtures — the same calls as an eval case's
 * (`@agboss/core/eval`): the open pause of a target the test's last call left, answered for an actor.
 */
import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { TestFailure, testWith } from "../../src/testing/index.js";
import {
  ListFinanceExternalTask,
  ListOwnerExternalTask,
  ListOwnerWorkflowStart,
  ListingApplication,
} from "../flow/fixtures/list-pauses.fixture.js";

const test = testWith(ListingApplication);
const order = { orderId: "o-1", note: "n" };

describe("#1328d: answerPause and replyToPause on the fixtures", () => {
  test("answerPause resumes the open pause of its target for the actor", async ({
    app,
    answerPause,
  }) => {
    const paused = await app.execute(ListOwnerWorkflowStart, order, {
      threadId: "t-1",
      ownerId: "alice",
    });
    expect(paused.status).toBe(ExecutionStatus.Paused);

    const done = await answerPause(
      ListOwnerExternalTask,
      { approved: true },
      {
        actor: { id: "alice" },
      },
    );

    expect(done.status).toBe(ExecutionStatus.Finished);
  });

  test("the thread's owner only: another actor's answer is refused", async ({
    app,
    answerPause,
  }) => {
    await app.execute(ListOwnerWorkflowStart, order, { threadId: "t-2", ownerId: "alice" });

    await expect(
      answerPause(ListOwnerExternalTask, { approved: true }, { actor: { id: "mallory" } }),
    ).rejects.toThrow();
  });

  test("a target with no open pause, or nothing executed yet, is test.no-open-pause", async ({
    app,
    answerPause,
    replyToPause,
  }) => {
    await expect(replyToPause(ListOwnerExternalTask, "yes")).rejects.toMatchObject({
      code: "test.no-open-pause",
    });
    await app.execute(ListOwnerWorkflowStart, order, { threadId: "t-3", ownerId: "alice" });

    const failure = await answerPause(ListFinanceExternalTask, { approved: true }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(TestFailure);
    expect(failure).toMatchObject({ code: "test.no-open-pause" });
    expect(String(failure)).toContain("list-owner-external-task");
  });
});
