/**
 * #1307c: `permitAnswer` of a pause target is called by `app.resume` before an answer is recorded —
 * only `true` lets it through (`false`, a throw and any other value refuse it with
 * `PauseError.PermissionDenied`, the pause stays pending, the tool does not run) — and an owner's target with
 * no channel asks nobody and waits for the owner's resume. The guarantees of a resume stay: after the
 * deadline and on a second answer it is refused before the hook is asked.
 */
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { PauseError, PauseStatus, PausedExecutionRepository } from "../../src/index.js";
import { PauseKind } from "../../src/pause/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { hours } from "../../src/units/index.js";
import {
  PurchaseWorkflowFinish,
  PurchaseWorkflowStart,
} from "../flow/fixtures/questions.fixture.js";
import { execute } from "../helpers/flow.js";
import {
  GatedClerkAgent,
  GatedFinish,
  GatedRefundChannel,
  GatedRefundTool,
  GatedStart,
  OwnerClerkAgent,
  OwnerFinish,
  OwnerRefundTool,
  OwnerStart,
  PermitApplication,
  PermitPolicy,
  PermitRefunds,
} from "./pause-permit.fixture.js";

const test = testWith(PermitApplication);

const dana = { actor: { id: "dana" } };
const approve = { approved: true } as const;

describe("#1307c: permitAnswer gates the answer of a delegate approval", () => {
  test("false refuses it: the pause keeps waiting, the tool does not run; a permitted answer then goes through", async ({
    app,
    mockModel,
  }) => {
    mockModel(GatedClerkAgent).thenReturn(
      callTool(GatedRefundTool, { orderId: "A-1" }),
      replyWith("Refunded."),
    );
    await execute(app, GatedStart, { text: "refund A-1" });
    const policy = app.resolve(PermitPolicy);
    const { pauseId } = app.resolve(GatedRefundChannel).asked[0] ?? { pauseId: "" };
    policy.verdict = false;

    const refused = await app
      .resume({ pauseId, decision: approve }, dana)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PauseError.PermissionDenied);
    const stored = await app
      .resolve(PausedExecutionRepository)
      .findByTenantIdAndPauseId("default", pauseId);
    expect(stored?.status).toBe(PauseStatus.Pending);
    expect(app.resolve(PermitRefunds).refunded).toEqual([]);

    policy.verdict = true;
    const done = await app.resume({ pauseId, decision: approve }, dana);

    expect(done).toFinishWith(GatedFinish, { text: "Refunded." });
    expect(app.resolve(PermitRefunds).refunded).toEqual(["A-1"]);
  });

  test("a throw refuses it too: the error names the pause, not the hook's text", async ({
    app,
    mockModel,
  }) => {
    mockModel(GatedClerkAgent).thenReturn(callTool(GatedRefundTool, { orderId: "A-1" }));
    await execute(app, GatedStart, { text: "refund A-1" });
    app.resolve(PermitPolicy).verdict = "throw";
    const { pauseId } = app.resolve(GatedRefundChannel).asked[0] ?? { pauseId: "" };

    const refused = await app
      .resume({ pauseId, decision: approve }, dana)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PauseError.PermissionDenied);
    expect((refused as Error).message).not.toContain("the hook failed");
    expect((refused as Error).cause).toMatchObject({ message: "the hook failed" });
    const stored = await app
      .resolve(PausedExecutionRepository)
      .findByTenantIdAndPauseId("default", pauseId);
    expect(stored?.status).toBe(PauseStatus.Pending);
    expect(app.resolve(PermitRefunds).refunded).toEqual([]);
  });

  test.for([undefined, "yes", 1, null])(
    "a verdict that is not true (%s) refuses it",
    async (verdict, { app, mockModel }) => {
      mockModel(GatedClerkAgent).thenReturn(callTool(GatedRefundTool, { orderId: "A-1" }));
      await execute(app, GatedStart, { text: "refund A-1" });
      app.resolve(PermitPolicy).verdict = verdict;
      const { pauseId } = app.resolve(GatedRefundChannel).asked[0] ?? { pauseId: "" };

      await expect(app.resume({ pauseId, decision: approve }, dana)).rejects.toBeInstanceOf(
        PauseError.PermissionDenied,
      );
      expect(app.resolve(PermitRefunds).refunded).toEqual([]);
    },
  );

  test("the hook reads who answered, the tool call, its arguments and the decision", async ({
    app,
    mockModel,
  }) => {
    mockModel(GatedClerkAgent).thenReturn(
      callTool(GatedRefundTool, { orderId: "A-1" }),
      replyWith("Refunded."),
    );
    await execute(app, GatedStart, { text: "refund A-1" });
    const { pauseId } = app.resolve(GatedRefundChannel).asked[0] ?? { pauseId: "" };

    await app.resume({ pauseId, decision: { approved: false, reason: "late" } }, dana);

    expect(app.resolve(PermitPolicy).asked).toMatchObject([
      {
        actor: { id: "dana" },
        input: { orderId: "A-1" },
        output: { approved: false, reason: "late" },
        toolCall: { tool: "gated-refund-tool" },
        trail: [expect.objectContaining({ action: "opened" })],
      },
    ]);
  });

  test("a second answer is refused as closed, before the hook is asked again", async ({
    app,
    mockModel,
  }) => {
    mockModel(GatedClerkAgent).thenReturn(
      callTool(GatedRefundTool, { orderId: "A-1" }),
      replyWith("Refunded."),
    );
    await execute(app, GatedStart, { text: "refund A-1" });
    const { pauseId } = app.resolve(GatedRefundChannel).asked[0] ?? { pauseId: "" };
    await app.resume({ pauseId, decision: approve }, dana);
    const policy = app.resolve(PermitPolicy);
    policy.asked.length = 0;

    await expect(app.resume({ pauseId, decision: approve }, dana)).rejects.toBeInstanceOf(
      PauseError.Closed,
    );
    expect(policy.asked).toEqual([]);
    expect(app.resolve(PermitRefunds).refunded).toEqual(["A-1"]);
  });

  test("an answer after the deadline is refused as closed, before the hook is asked", async ({
    app,
    mockModel,
    clock,
  }) => {
    mockModel(GatedClerkAgent).thenReturn(callTool(GatedRefundTool, { orderId: "A-1" }));
    await execute(app, GatedStart, { text: "refund A-1" });
    const { pauseId } = app.resolve(GatedRefundChannel).asked[0] ?? { pauseId: "" };
    await clock.advance(hours(5));

    await expect(app.resume({ pauseId, decision: approve }, dana)).rejects.toBeInstanceOf(
      PauseError.Closed,
    );
    expect(app.resolve(PermitPolicy).asked).toEqual([]);
    expect(app.resolve(PermitRefunds).refunded).toEqual([]);
  });
});

describe("#1307c: an owner's target with no channel asks nobody", () => {
  test("a tool approval waits for the owner's resume: recorded as sent, no channel was called", async ({
    app,
    mockModel,
  }) => {
    mockModel(OwnerClerkAgent).thenReturn(
      callTool(OwnerRefundTool, { orderId: "B-2" }),
      replyWith("Refunded."),
    );

    const paused = await execute(app, OwnerStart, { text: "refund B-2" }, { ownerId: "alice" });

    expect(paused).toMatchObject({
      status: ExecutionStatus.Paused,
      pending: [
        {
          kind: PauseKind.Approval,
          respondent: "owner",
          toolCall: { tool: "owner-refund-tool" },
        },
      ],
    });
    const [pending] = paused.pending;
    const stored = await app
      .resolve(PausedExecutionRepository)
      .findByTenantIdAndPauseId("default", pending?.pauseId ?? "");
    expect(stored).toMatchObject({ status: PauseStatus.Pending, isSent: true });
    await expect(
      app.resume({ pauseId: pending?.pauseId ?? "", decision: approve }, { ownerId: "bob" }),
    ).rejects.toBeInstanceOf(ExecutionError.ThreadOwnerMismatch);
    expect(app.resolve(PermitRefunds).refunded).toEqual([]);

    const done = await app.resume(
      { pauseId: pending?.pauseId ?? "", decision: approve },
      { ownerId: "alice" },
    );

    expect(done).toFinishWith(OwnerFinish, { text: "Refunded." });
    expect(app.resolve(PermitRefunds).refunded).toEqual(["B-2"]);
  });

  test("an external task step waits for the owner's reply", async ({ app }) => {
    const paused = await execute(
      app,
      PurchaseWorkflowStart,
      { text: "laptop for 900" },
      { threadId: "purchase-silent", ownerId: "alice" },
    );

    expect(paused).toMatchObject({
      status: ExecutionStatus.Paused,
      pending: [{ respondent: "owner", step: "silent-limit-external-task" }],
    });
    const done = await app.resume(
      { pauseId: paused.pending[0]?.pauseId ?? "", decision: { approved: true, limitUsd: 1200 } },
      { ownerId: "alice" },
    );

    expect(done).toFinishWith(PurchaseWorkflowFinish, {
      status: "placed laptop at 900 within 1200",
    });
  });
});
