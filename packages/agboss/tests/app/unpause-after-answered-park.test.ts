/**
 * Bug hunt 2026-11-25 (pauses, finding 4): a tree resumed from a business pause and parked by
 * `app.pause` (AfterStep) at a later step boundary is a parked tree, not a business rest — the
 * paused run its earlier rest left behind is stale. `app.unpause` continues it from its checkpoint
 * (`running/unpause`) — the same open-pauses check decides `dual-paused` for a second `app.pause`.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  Charge,
  Clerk,
  KeptCheckoutApplication,
  Probe,
  ReceiptDto,
  resetSeen,
  seen,
  Slow,
  Start,
} from "./fixtures/run-context.workflow.js";

const test = testWith(KeptCheckoutApplication);
beforeEach(resetSeen);

/** Runs to the approval, answers it, and parks the resumed pass after its next step. */
async function parkedAfterAnswer(app: TestApp) {
  const paused = await execute(app, Start, { text: "charge" });
  expect(paused.status).toBe(ExecutionStatus.Paused);
  const resumed = app.resume(answerOf(paused, { approved: true }));
  await until(() => seen.charges.length === 1);
  await app.pause(paused.threadId, { reason: "maintenance" });
  const parked = await resumed;
  expect(parked).toMatchObject({ status: ExecutionStatus.Paused, isExternallyPaused: true });
  return paused.threadId;
}

describe("a tree parked after its business pause was answered", () => {
  test("app.unpause continues it to its finish; the history says running/unpause", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      callTool(Slow, { text: "s" }),
      callTool(Probe, { text: "p" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    const threadId = await parkedAfterAnswer(app);

    const unpaused = await app.unpause(threadId, { reason: "done" });

    expect(unpaused.status).toBe(ExecutionStatus.Finished);
    expect(seen.charges).toHaveLength(1);
    expect(seen.payments).toHaveLength(1);
    const history = (await app.getStatusHistory(threadId)).map(
      (row) => `${row.toStatus}/${row.trigger}`,
    );
    expect(history).toContain("running/unpause");
    expect(history).not.toContain("paused/unpause");
  });
});
