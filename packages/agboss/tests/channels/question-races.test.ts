/**
 * #659 AC5: a question pause is answered exactly once — a second answer, sequential or at the same
 * time, is refused; another instance continues it; a cancel withdraws it; another tenant or owner
 * cannot answer it; a cycle asks it at most `maxVisits` times.
 */
import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { UnknownPauseError } from "../../src/run/resume-agent.js";
import { NotPausedError, PauseStatus, PausedExecutionRepository } from "../../src/index.js";
import { ThreadOwnerError } from "../../src/core/errors.js";
import { VisitsLimitExceededError } from "../../src/flow/runtime/errors.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import {
  OwnerPurchaseWorkflowFinish,
  OwnerPurchaseWorkflowStart,
  PurchaseWorkflowFinish,
  PurchaseWorkflowStart,
  QuestionInbox,
  QuestionsApplication,
} from "../flow/fixtures/questions.fixture.js";
import { answerOf, execute } from "../helpers/flow.js";

const test = testWith(QuestionsApplication, { instances: 2 });

const owner = { ownerId: "alice" };
const asking = { threadId: "purchase-1", ownerId: "alice" };
const yes = { approved: true, limitUsd: 1000 };

const second = (apps: readonly TestApp[]): TestApp => {
  const [, other] = apps;
  if (other === undefined) throw new Error("the test runs two instances");
  return other;
};

const statusOf = async (app: TestApp, pauseId: string): Promise<PauseStatus | undefined> =>
  (await app.resolve(PausedExecutionRepository).findByTenantIdAndPauseId("default", pauseId))
    ?.status;

describe("#659 AC5: exactly one answer wins", () => {
  test("AC5: a second answer after the first is NotPausedError; the first one's answer stays", async ({
    app,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);
    const done = await app.resume(answerOf(paused, yes), owner);

    await expect(
      app.resume(answerOf(paused, { approved: false, limitUsd: 0 }), owner),
    ).rejects.toBeInstanceOf(NotPausedError);
    expect(done).toFinishWith(PurchaseWorkflowFinish, {
      status: "placed laptop at 900 within 1000",
    });
    expect(app.resolve(QuestionInbox).placed).toEqual([yes]);
  });

  test("AC5: two answers at once on two instances: one moves the tree, the other is refused", async ({
    app,
    apps,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);
    const no = { approved: false, limitUsd: 0 };

    const settled = await Promise.allSettled([
      app.resume(answerOf(paused, yes), owner),
      second(apps).resume(answerOf(paused, no), owner),
    ]);

    const won = settled.filter((each) => each.status === "fulfilled");
    const lost = settled.filter((each) => each.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost.map((each): unknown => each.reason)).toEqual([expect.any(NotPausedError)]);
    const placed = [
      ...app.resolve(QuestionInbox).placed,
      ...second(apps).resolve(QuestionInbox).placed,
    ];
    expect(placed).toHaveLength(1);
    const status = won[0]?.status === "fulfilled" ? won[0].value.output : undefined;
    expect(status).toEqual(
      placed[0]?.approved === true
        ? { status: "placed laptop at 900 within 1000" }
        : { status: "declined laptop" },
    );
  });

  test("AC5: asked on one instance, answered on the other: the channel is never asked again", async ({
    app,
    apps,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);

    const done = await second(apps).resume(answerOf(paused, yes), owner);

    expect(done).toFinishWith(PurchaseWorkflowFinish, {
      status: "placed laptop at 900 within 1000",
    });
    expect(app.resolve(QuestionInbox).asked).toHaveLength(1);
    expect(second(apps).resolve(QuestionInbox).asked).toEqual([]);
    expect(second(apps).resolve(QuestionInbox).placed).toEqual([yes]);
  });
});

describe("#659 AC5: cancel, tenants and owners", () => {
  test("AC5: app.cancel while paused withdraws the question; a late answer is refused", async ({
    app,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    await app.cancel("purchase-1", owner);

    expect(await statusOf(app, pauseId)).toBe(PauseStatus.Cancelled);
    await expect(app.resume(answerOf(paused, yes), owner)).rejects.toBeInstanceOf(NotPausedError);
    expect(app.resolve(QuestionInbox).placed).toEqual([]);
  });

  test("AC5: another tenant's id is unknown; another owner is refused; the pause stays pending", async ({
    app,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    await expect(
      app.resume(answerOf(paused, yes), { tenantId: "acme", ownerId: "alice" }),
    ).rejects.toBeInstanceOf(UnknownPauseError);
    await expect(app.resume(answerOf(paused, yes), { ownerId: "mallory" })).rejects.toBeInstanceOf(
      ThreadOwnerError,
    );
    await expect(app.resume(answerOf(paused, yes), { answeredBy: "alice" })).rejects.toThrow(
      /pass ownerId, not answeredBy/,
    );
    expect(await statusOf(app, pauseId)).toBe(PauseStatus.Pending);
  });
});

describe("#659 AC5: maxVisits on a cycle", () => {
  test("AC5: asked again below the price, at most maxVisits times", async ({ app }) => {
    const paused = await execute(app, OwnerPurchaseWorkflowStart, { text: "desk for 700" });
    const inbox = app.resolve(QuestionInbox);
    const by = { answeredBy: "budget-owner-7" };
    const pauseIdOf = (index: number): string => inbox.ownerAsked[index]?.pauseId ?? "";
    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending[0]?.pauseId).toBeUndefined(); // a Channel pause hides its id

    const again = await app.resume(
      { pauseId: pauseIdOf(0), decision: { approved: true, limitUsd: 500 } },
      by,
    );
    expect(again.status).toBe(ExecutionStatus.Paused);
    expect(inbox.ownerAsked).toHaveLength(2);

    await expect(
      app.resume({ pauseId: pauseIdOf(1), decision: { approved: true, limitUsd: 600 } }, by),
    ).rejects.toBeInstanceOf(VisitsLimitExceededError);
    expect(inbox.ownerAsked).toHaveLength(2);
  });

  test("AC5: answered within the price on the second ask, it finishes", async ({ app }) => {
    await execute(app, OwnerPurchaseWorkflowStart, { text: "desk for 700" });
    const inbox = app.resolve(QuestionInbox);
    const by = { answeredBy: "budget-owner-7" };
    await app.resume(
      { pauseId: inbox.ownerAsked[0]?.pauseId ?? "", decision: { approved: true, limitUsd: 500 } },
      by,
    );

    const done = await app.resume(
      { pauseId: inbox.ownerAsked[1]?.pauseId ?? "", decision: { approved: true, limitUsd: 800 } },
      by,
    );

    expect(done).toFinishWith(OwnerPurchaseWorkflowFinish, { status: "placed within 800" });
  });
});
