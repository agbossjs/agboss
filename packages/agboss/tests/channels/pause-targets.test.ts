/**
 * #1307a / #1310c: `@ExternalTask`, `@ToolApproval`, `@Channel({ target })`, `@ChannelInterpreter`
 * and `@ChannelListener` run on the runtime the old form runs on — the cases of question-step,
 * question-replies and approval-channels, ported to the new names: the same pause, the same
 * answers, the same guarantees.
 */
import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  PauseStatus,
  PausedExecutionRepository,
  UninterpretableReplyError,
} from "../../src/index.js";
import { PauseKind } from "../../src/pause/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import {
  PurchaseWorkflowFinish,
  PurchaseWorkflowStart,
} from "../flow/fixtures/questions.fixture.js";
import { execute } from "../helpers/flow.js";
import {
  ClosedOnlyChannelListener,
  ClerkAgent,
  OpenedOnlyChannelListener,
  RefundTool,
  RefundWorkflowFinish,
  RefundWorkflowStart,
  TargetInbox,
  TargetsApplication,
} from "./pause-targets.fixture.js";

const test = testWith(TargetsApplication);

const owner = { ownerId: "alice" };
const asking = { threadId: "purchase-1", ownerId: "alice" };

describe("#1307a: an @ExternalTask step pauses like a question and its channel is found by target", () => {
  test("the channel it names by target is asked once, the pause is the owner's", async ({
    app,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.path).toEqual([
      "purchase-workflow-start",
      "draft-question-action",
      "spending-limit-external-task",
    ]);
    expect(paused.pending).toMatchObject([
      {
        kind: PauseKind.Question,
        answerer: "thread-owner",
        step: "spending-limit-external-task",
        channel: "spending-limit-external-task",
      },
    ]);
    const { asked } = app.resolve(TargetInbox);
    expect(asked).toEqual([
      expect.objectContaining({
        pauseId: paused.pending[0]?.pauseId,
        input: paused.pending[0]?.input,
      }),
    ]);
  });

  test("a reply is read by the @ChannelInterpreter into the output; the answer goes on the path", async ({
    app,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    const done = await app.resume({ pauseId, reply: "sure, up to 1200" }, owner);

    expect(done).toFinishWith(PurchaseWorkflowFinish, {
      status: "placed laptop at 900 within 1200",
    });
  });

  test("notUnderstood(reason) keeps the pause pending with that reason; a clearer reply resumes", async ({
    app,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    const unread = await app
      .resume({ pauseId, reply: "🤷" }, owner)
      .catch((error: unknown) => error);

    expect(unread).toBeInstanceOf(UninterpretableReplyError);
    expect(unread).toMatchObject({ reason: '"🤷" names no limit' });
    const pauses = app.resolve(PausedExecutionRepository);
    expect((await pauses.findByTenantIdAndPauseId("default", pauseId))?.status).toBe(
      PauseStatus.Pending,
    );
    const done = await app.resume({ pauseId, reply: "no" }, owner);
    expect(done).toFinishWith(PurchaseWorkflowFinish, { status: "declined laptop" });
  });

  test("the @ChannelListener of one hook is told the opening; the one of another is not", async ({
    app,
  }) => {
    await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);

    await expect.poll(() => app.resolve(OpenedOnlyChannelListener).opened.length).toBe(1);
    expect(app.resolve(ClosedOnlyChannelListener).closed).toEqual([]);
  });
});

describe("#1307a: a @ToolApproval gates a tool named by `approval`", () => {
  test("the tool call is asked of the channel serving the approval, answered and run", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ClerkAgent).thenReturn(
      callTool(RefundTool, { orderId: "A-1" }),
      replyWith("Refunded."),
    );

    const paused = await execute(app, RefundWorkflowStart, { text: "refund A-1" });

    expect(paused).toMatchObject({
      status: ExecutionStatus.Paused,
      pending: [
        { kind: PauseKind.Approval, answerer: "channel", toolCall: { tool: "refund-tool" } },
      ],
    });
    const inbox = app.resolve(TargetInbox);
    expect(inbox.approvals).toHaveLength(1);
    expect(inbox.refunded).toEqual([]);

    // a delegate pause's id is the channel's: only it has it
    const pauseId = inbox.approvals[0]?.pauseId ?? "";
    const done = await app.resume(
      { pauseId, decision: { approved: true } },
      { actor: { id: "dana" } },
    );

    expect(done).toFinishWith(RefundWorkflowFinish, { text: "Refunded." });
    expect(inbox.refunded).toEqual(["A-1"]);
  });

  test("a rejection resumes the run without the tool", async ({ app, mockLlm }) => {
    mockLlm(ClerkAgent).thenReturn(
      callTool(RefundTool, { orderId: "A-1" }),
      replyWith("Not refunded."),
    );
    const paused = await execute(app, RefundWorkflowStart, { text: "refund A-1" });

    const done = await app.resume(
      {
        pauseId: app.resolve(TargetInbox).approvals[0]?.pauseId ?? "",
        decision: { approved: false, reason: "no" },
      },
      { actor: { id: "dana" } },
    );

    expect(done).toFinishWith(RefundWorkflowFinish, { text: "Not refunded." });
    expect(app.resolve(TargetInbox).refunded).toEqual([]);
  });
});
