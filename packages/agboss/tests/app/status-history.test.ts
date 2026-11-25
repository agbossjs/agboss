import { beforeEach, describe, expect, vi } from "vitest";
import { InvalidThreadIdError } from "../../src/core/errors.js";
import { ExecutionRecordRepository } from "../../src/index.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  blocking,
  Clerk,
  CheckoutApplication,
  KeptCheckoutApplication,
  resetSeen,
  Start,
  Wait,
} from "./fixtures/run-context.workflow.js";

const test = testWith(KeptCheckoutApplication);
const forgetful = testWith(CheckoutApplication);

beforeEach(resetSeen);

/** #1341d: `app.getStatusHistory` — each change of a thread's status is a row, in the order made. */
describe("#1341d: app.getStatusHistory", () => {
  test("a cancelled run reads running, cancelling (with its reason and actor), cancelled", async ({
    app,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Wait, { text: "a long job" }));
    const started = new Promise<string>((resolve) => {
      blocking.started = resolve;
    });
    const run = execute(app, Start, { text: "wait" }, { ownerId: "ops-1" });
    const threadId = await started;

    await app.cancel(threadId, { ownerId: "ops-1", reason: "customer withdrew" });
    await run;
    const history = await app.getStatusHistory(threadId);

    expect(
      history.map(({ seq, fromStatus, toStatus, trigger }) => [seq, fromStatus, toStatus, trigger]),
    ).toEqual([
      [1, null, "running", "start"],
      [2, "running", "cancelling", "cancel"],
      [3, "cancelling", "cancelled", "cancel"],
    ]);
    expect(history[1]).toMatchObject({
      tenantId: DEFAULT_TENANT_ID,
      threadId,
      actor: "ops-1",
      reason: "customer withdrew",
    });
    expect(history[1]?.at).toBeInstanceOf(Date);
  });

  test("a thread id that is no key's text is refused before any store is read, never echoed", async ({
    app,
  }) => {
    await app.ready();
    const read = vi.spyOn(app.resolve(ExecutionRecordRepository), "statusHistory");

    const error = await app.getStatusHistory("t\uD800").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidThreadIdError);
    expect(String(error)).not.toContain("\uD800");
    expect(read).not.toHaveBeenCalled();
  });

  test("a thread nobody ran has an empty history", async ({ app }) => {
    expect(await app.getStatusHistory("nobody")).toEqual([]);
  });

  forgetful(
    "an application that keeps no history forgets a thread's rows when its tree ends",
    async ({ app, mockModel }) => {
      mockModel(Clerk).thenReturn(callTool(Wait, { text: "a long job" }));
      const started = new Promise<string>((resolve) => {
        blocking.started = resolve;
      });
      const run = execute(app, Start, { text: "wait" }, { ownerId: "ops-1" });
      const threadId = await started;
      await app.cancel(threadId, { ownerId: "ops-1" });
      await run;

      expect(await app.getStatusHistory(threadId)).toEqual([]);
    },
  );
});
