/**
 * #659 AC2 / AC3: a question role's step pauses like any pause, and its typed answer — a decision,
 * or a channel's `decided(…)` — goes on the path for the steps after it.
 */
import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { DtoValidationError } from "../../src/dto/errors.js";
import { PauseResolution, PauseStatus, PausedExecutionRepository } from "../../src/index.js";
import { PauseKind } from "../../src/pause/index.js";
import { testWith } from "../../src/testing/index.js";
import {
  PurchaseWorkflowFinish,
  PurchaseWorkflowStart,
  QuestionInbox,
  QuestionsApplication,
  RuleQuestionsApplication,
} from "../flow/fixtures/questions.fixture.js";
import { answerOf, execute } from "../helpers/flow.js";

const test = testWith(QuestionsApplication);
const ruled = testWith(RuleQuestionsApplication);

const owner = { ownerId: "alice" };
const asking = { threadId: "purchase-1", ownerId: "alice" };

describe("#659 AC2: a question pauses like any pause", () => {
  test("AC2: result.pending lists the question with its masked ask; the channel is asked once", async ({
    app,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.path).toEqual([
      "purchase-workflow-start",
      "draft-question-action",
      "spending-limit-question",
    ]);
    expect(paused.pending).toEqual([
      {
        kind: PauseKind.Question,
        pauseId: expect.any(String),
        answeredBy: "thread-owner",
        agent: "spending-limit-question",
        channel: "spending-limit-question",
        childExecutionId: undefined,
        itemIndex: undefined,
        // the requester is `sensitive`: masked in the record, the channel's ask and the result
        ask: { item: "laptop", priceUsd: 900, requester: expect.not.stringContaining("alice") },
      },
    ]);
    const inbox = app.resolve(QuestionInbox);
    expect(inbox.asked).toEqual([
      { pauseId: paused.pending[0]?.pauseId, value: paused.pending[0]?.ask },
    ]);
    expect(inbox.placed).toEqual([]);
    const pauses = app.resolve(PausedExecutionRepository);
    const pause = await pauses.findByTenantIdAndPauseId(
      "default",
      paused.pending[0]?.pauseId ?? "",
    );
    expect(pause).toMatchObject({
      status: PauseStatus.Pending,
      isSent: true,
      component: { name: "spending-limit-question", kind: "question" },
    });
  });

  ruled(
    "AC2: a channel's decided(answer) goes on at once, logged Decided, nothing pending",
    async ({ app }) => {
      const done = await execute(
        app,
        PurchaseWorkflowStart,
        { text: "mouse for 40" },
        { ...asking, record: true },
      );

      expect(done).toFinishWith(PurchaseWorkflowFinish, {
        status: "placed mouse at 40 within 100",
      });
      expect(done.pending).toEqual([]);
      expect(done.record?.pauses).toEqual([
        expect.objectContaining({
          resolution: PauseResolution.Decided,
          decision: { approved: true, limitUsd: 100 },
        }),
      ]);
    },
  );
});

describe("#659 AC3: the typed answer reaches later nodes", () => {
  test("AC3: app.resume with the answer DTO continues; the action reads the answer and the ask", async ({
    app,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);

    const done = await app.resume(answerOf(paused, { approved: true, limitUsd: 1000 }), owner);

    expect(done).toFinishWith(PurchaseWorkflowFinish, {
      status: "placed laptop at 900 within 1000",
    });
    expect(done.path).toEqual([
      "purchase-workflow-start",
      "draft-question-action",
      "spending-limit-question",
      "place-purchase-action",
      "purchase-workflow-finish",
    ]);
    expect(app.resolve(QuestionInbox).placed).toEqual([{ approved: true, limitUsd: 1000 }]);
    // the channel is asked once: the resumed step found its answer, it did not ask again
    expect(app.resolve(QuestionInbox).asked).toHaveLength(1);
  });

  test("AC3: an answer that is not the answer DTO is refused before it is recorded", async ({
    app,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    await expect(
      app.resume({ pauseId, decision: { approved: true } }, owner),
    ).rejects.toBeInstanceOf(DtoValidationError);
    await expect(
      app.resume({ pauseId, decision: { approved: true, limitUsd: -1 } }, owner),
    ).rejects.toBeInstanceOf(DtoValidationError);

    const pause = await app
      .resolve(PausedExecutionRepository)
      .findByTenantIdAndPauseId("default", pauseId);
    expect(pause?.status).toBe(PauseStatus.Pending);
    const done = await app.resume({ pauseId, decision: { approved: false, limitUsd: 0 } }, owner);
    expect(done).toFinishWith(PurchaseWorkflowFinish, { status: "declined laptop" });
  });

  test("AC3: result.record.pauses holds who answered and the answer", async ({ app }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);

    const done = await app.resume(answerOf(paused, { approved: true, limitUsd: 950 }), {
      ...owner,
      record: true,
    });

    expect(done.record?.pauses).toEqual([
      expect.objectContaining({
        role: "spending-limit-question",
        answeredBy: "thread-owner",
        responder: "alice",
        resolution: PauseResolution.Replied,
        decision: { approved: true, limitUsd: 950 },
        step: expect.objectContaining({
          component: expect.objectContaining({ kind: "question" }),
          callId: undefined,
        }),
      }),
    ]);
  });
});
