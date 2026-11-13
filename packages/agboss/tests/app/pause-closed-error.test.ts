/**
 * #939 (#910 AC7, the engine's part): a late answer is refused with `PauseClosedError` — the reason
 * the pause closed and when, the pause named by its key in the message, never by its id — before a
 * reply's interpreter is asked.
 */
import { beforeEach, describe, expect } from "vitest";
import { cancelledRecordOutcome, CANCELLED_STOP_REASON } from "../../src/app/live-runs.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { PauseClosedError, PauseClosedReason, UnknownPauseError } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { minutes } from "../../src/units/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  LeaseApplication,
  OrderWorkflowStart,
  ReceiptDto,
  resetLease,
  seen,
} from "../infrastructure/fixtures/lease.workflow.js";

const approve = { approved: true };
const test = testWith(LeaseApplication);

beforeEach(resetLease);

/** The refusal an answer got, or a failing assertion. */
async function refusedWith(answer: Promise<unknown>): Promise<PauseClosedError> {
  const error = await answer.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(PauseClosedError);
  if (!(error instanceof PauseClosedError)) throw new Error("not a PauseClosedError");
  return error;
}

describe("#939 AC4: a late answer is a PauseClosedError with its reason", () => {
  test("a second answer: answered, closedAt the first answer's time, the key in the message and the id in a field", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk)
      .thenReturn(callTool(Charge, { text: "10 USD" }))
      .thenReturn(replyWith(ReceiptDto, { text: "charged" }));
    const paused = await execute(app, OrderWorkflowStart, { text: "charge" });
    const pauseId = paused.pending[0]?.pauseId ?? "";
    const answeredAt = clock.now().toISOString();
    await app.resume(answerOf(paused, approve));
    await clock.advance(minutes(1));

    const error = await refusedWith(app.resume({ pauseId, decision: approve }));

    expect(error).toMatchObject({
      code: "pause.closed",
      pauseId,
      reason: PauseClosedReason.Answered,
      closedAt: answeredAt,
    });
    expect(error.message).toBe(
      `pause ${pauseKeyOf(DEFAULT_TENANT_ID, pauseId)} is closed: answered at ${answeredAt}`,
    );
    expect(error.message).not.toContain(pauseId);
    expect(seen.charges).toEqual(["10 USD"]);
  });

  test("after app.cancel: cancelled, closedAt the cancel's time; a reply to it asks no interpreter", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const paused = await execute(app, OrderWorkflowStart, { text: "charge" });
    const pauseId = paused.pending[0]?.pauseId ?? "";
    await clock.advance(minutes(2));
    const cancelledAt = clock.now().toISOString();
    await app.cancel(paused.threadId);
    await clock.advance(minutes(1));

    const error = await refusedWith(app.resume({ pauseId, decision: approve }));
    // a reply of a role with no interpreter would be `ReplyInterpreterMissingError` if it were read
    const reply = await refusedWith(app.resume({ pauseId, reply: "yes, go ahead" }));

    expect(error).toMatchObject({ reason: PauseClosedReason.Cancelled, closedAt: cancelledAt });
    expect(reply).toMatchObject({ reason: PauseClosedReason.Cancelled, closedAt: cancelledAt });
    expect(seen.charges).toEqual([]);
  });

  for (const [ended, reason, stopReason] of [
    ["a tree failure", PauseClosedReason.TreeEnded, "the tree failed"],
    ["a cancel", PauseClosedReason.Cancelled, CANCELLED_STOP_REASON],
  ] as const)
    test(`after ${ended} that left the pause open (its root's record ended): the resume finishes the end and is refused — ${reason}`, async ({
      app,
      clock,
      mockLlm,
    }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
      const paused = await execute(app, OrderWorkflowStart, { text: "charge" });
      const pauseId = paused.pending[0]?.pauseId ?? "";
      const records = seen.records[0];
      const [record] = (await records?.lastTurns(DEFAULT_TENANT_ID, paused.threadId, 1)) ?? [];
      if (records === undefined || record === undefined) throw new Error("the pause has no record");
      const outcome = cancelledRecordOutcome(record.route, record.costUsd);
      await records.complete(record.id, { ...outcome, status: "failed", stopReason });
      await clock.advance(minutes(3));
      const closedAt = clock.now().toISOString();

      const error = await refusedWith(app.resume({ pauseId, decision: approve }));

      expect(error).toMatchObject({ reason, closedAt });
      expect(seen.charges).toEqual([]);
    });

  test("an id the tenant never had is still UnknownPauseError", async ({ app }) => {
    await expect(
      app.resume({ pauseId: "no-such-pause", decision: approve }),
    ).rejects.toBeInstanceOf(UnknownPauseError);
  });
});
