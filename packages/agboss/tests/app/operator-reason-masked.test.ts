/**
 * Bug hunt 2026-11-25 (pauses, finding 5): an operator's reason — a cancel's, a stop's, a pause's,
 * an unpause's — is kept by the tree through the workflow's PII policy, as a reassignment's is:
 * the status history never holds it raw.
 */
import { beforeEach, describe, expect } from "vitest";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  blocking,
  Clerk,
  MaskedCheckoutApplication,
  resetSeen,
  Start,
  Wait,
} from "./fixtures/run-context.workflow.js";

const test = testWith(MaskedCheckoutApplication);
const EMAIL = "jane.roe@example.com";
beforeEach(resetSeen);

/** A run blocked in its long call: its thread. */
async function blocked(app: TestApp) {
  const started = new Promise<string>((resolve) => {
    blocking.started = resolve;
  });
  const run = execute(app, Start, { text: "wait" });
  return { threadId: await started, run };
}

const reasonsOf = async (app: TestApp, threadId: string): Promise<string[]> =>
  (await app.getStatusHistory(threadId)).flatMap((row) =>
    row.reason === undefined ? [] : [row.reason],
  );

describe("an operator's reason is masked by the workflow's PII policy", () => {
  test("a cancel's", async ({ app, mockModel }) => {
    mockModel(Clerk).thenReturn(callTool(Wait, { text: "a long job" }));
    const { threadId, run } = await blocked(app);

    await app.cancel(threadId, { reason: `customer ${EMAIL} withdrew` });
    await run.catch(() => undefined);

    const reasons = await reasonsOf(app, threadId);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(" ")).not.toContain(EMAIL);
  });

  test("a stop's", async ({ app, mockModel }) => {
    mockModel(Clerk).thenReturn(callTool(Wait, { text: "a long job" }));
    const { threadId, run } = await blocked(app);

    await app.stop(threadId, { reason: `asked by ${EMAIL}`, mode: InterruptMode.Immediate });
    await run.catch(() => undefined);

    const reasons = await reasonsOf(app, threadId);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(" ")).not.toContain(EMAIL);
  });

  test("a pause's and an unpause's", async ({ app, mockModel }) => {
    mockModel(Clerk).thenReturn(callTool(Wait, { text: "a long job" }));
    const { threadId, run } = await blocked(app);

    await app.pause(threadId, { reason: `held for ${EMAIL}`, mode: InterruptMode.Immediate });
    await run;
    const again = new Promise<string>((resolve) => {
      blocking.started = resolve;
    });
    const unpaused = app.unpause(threadId, { reason: `released by ${EMAIL}` });
    await again;

    const reasons = await reasonsOf(app, threadId);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(reasons.join(" ")).not.toContain(EMAIL);
    await app.cancel(threadId);
    await unpaused.catch(() => undefined);
  });
});
