import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ApologizerAgent,
  ApologyDto,
  DeclinedFinish,
  PaidFinish,
  PaymentFailedFinish,
  PayStart,
  RefundTool,
  PayApplication,
} from "./fixtures/pay.workflow.js";

const test = testWith(PayApplication);
const approve = { approved: true, by: "dana" };

describe("#272 AC7: .onError(E, path) right after the step that throws", () => {
  test("the main path continues when the step succeeds", async ({ app }) => {
    const result = await execute(app, PayStart, { id: "7", outcome: "pay" });

    expect(result).toFinishWith(PaidFinish, { text: "paid 7" });
  });

  test("most specific handler: a declined card takes the CardDeclinedError side path", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ApologizerAgent).thenReturn(replyWith(ApologyDto, { text: "Sorry." }));

    const result = await execute(app, PayStart, { id: "7", outcome: "decline" }, { record: true });

    expect(result).toFinishWith(DeclinedFinish, { text: "Sorry." });
    expect(result.path).toEqual([
      "pay-workflow-start",
      "charge-action",
      "apologizer-agent",
      "declined-workflow-finish",
    ]);
    expect(result.record?.lastError).toMatchObject({
      code: "step.action",
      cause: {
        code: "test.payment.declined",
        lineage: ["test.payment.declined", "test.payment", "agboss"],
      },
    });
  });

  test("a parent class handles what has no handler of its own", async ({ app, mockLlm }) => {
    const result = await execute(app, PayStart, { id: "8", outcome: "fail" });

    expect(result).toFinishWith(PaymentFailedFinish, { id: "8", outcome: "fail" });
    expect(mockLlm(ApologizerAgent).requests).toHaveLength(0);
  });

  test("no handler for the failure: the execution fails", async ({ app }) => {
    const run = execute(app, PayStart, { id: "9", outcome: "crash" });

    await expect(run).rejects.toFailWith({ code: "step.action" });
    await expect(run).rejects.toThrow("the ledger is down");
  });

  test("after resume: the side path paused for an approval continues where it was", async ({
    app,
    recoverApp,
    mockLlm,
  }) => {
    mockLlm(ApologizerAgent).thenReturn(
      callTool(RefundTool, { id: "7" }),
      replyWith(ApologyDto, { text: "Refunded, sorry." }),
    );

    const paused = await execute(app, PayStart, { id: "7", outcome: "decline" });
    const restarted = await recoverApp();
    const done = await restarted.resume(paused.threadId, approve, { record: true });

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused).toHavePausedAt(ApologizerAgent);
    expect(done).toFinishWith(DeclinedFinish, { text: "Refunded, sorry." });
    expect(done.record?.lastError).toMatchObject({ code: "step.action" });
  });
});
