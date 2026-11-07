/**
 * #825 — an automatic undo writes under a business key: the undo's frame carries the application's
 * idempotency keys, as a step's does, so a refund's fenced effect and its outbound call are keyed
 * there — a root's undo (its execution failed) and a child's (in its parent's node) alike.
 */
import { beforeEach, describe, expect } from "vitest";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { OutboundCallRepository, OutboundCallStatus } from "../../src/index.js";
import {
  KeyedParentWorkflowStart,
  KeyedUndoApplication,
  KeyedUndoWorkflowStart,
  keyedUndoSeen,
} from "./fixtures/undo-business-key.workflow.js";

const test = testWith(KeyedUndoApplication);

beforeEach(() => {
  keyedUndoSeen.booked.length = 0;
  keyedUndoSeen.sent.length = 0;
});

const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#825: an undo under a business key", () => {
  test("a root's undo books and sends its refund once — the execution fails with the step's error, never the undo's", async ({
    app,
  }) => {
    const failed = await rejectionOf(
      execute(app, KeyedUndoWorkflowStart, { name: "root", delay: 0, outcome: "ok" }),
    );

    expect(failed).not.toMatchObject({ name: "CompensationFailedError" });
    expect((failed as Error).message).toContain("the carrier refused");
    expect(keyedUndoSeen).toEqual({ booked: ["booking-root"], sent: ["booking-root"] });
    // the refund's call is shown by its business key's handle: the undo had the PII key too
    const sent = await app.resolve(OutboundCallRepository).findAllByTenantIdAndStatus({
      tenantId: "default",
      status: OutboundCallStatus.Completed,
      limit: 10,
    });
    expect(sent.calls.map((call) => call.businessKeyHash)).toEqual([
      expect.stringMatching(/^[0-9a-f]{12}$/u),
    ]);
  });

  test("a child's undo, in its parent's node, does the same", async ({ app }) => {
    const failed = await rejectionOf(
      execute(app, KeyedParentWorkflowStart, { name: "child", delay: 0, outcome: "ok" }),
    );

    expect(failed).not.toMatchObject({ name: "CompensationFailedError" });
    expect(keyedUndoSeen).toEqual({ booked: ["booking-child"], sent: ["booking-child"] });
    const sent = await app.resolve(OutboundCallRepository).findAllByTenantIdAndStatus({
      tenantId: "default",
      status: OutboundCallStatus.Completed,
      limit: 10,
    });
    expect(sent.calls.map((call) => call.businessKeyHash)).toEqual([
      expect.stringMatching(/^[0-9a-f]{12}$/u),
    ]);
  });
});
