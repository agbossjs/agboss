/**
 * #265 PR 1 (#262 AC13 in its first form): `testWith(App, { instances: 2 })` — two application
 * instances, each its own container, over one set of stores and one clock (the virtual clock
 * itself: clock.test.ts).
 */
import { describe, expect, it } from "vitest";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  LeaseApplication,
  OrderWorkflowStart,
  ReceiptDto,
} from "../infrastructure/fixtures/lease.workflow.js";

const test = testWith(LeaseApplication, { instances: 2 });

describe("testWith(App, { instances: 2 })", () => {
  test("apps[0] is app; both share the stores and the clock", async ({
    app,
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "1 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    const paused = await execute(app, OrderWorkflowStart, { text: "charge" });

    const cancelled = await apps[1]?.cancel(paused.threadId);

    expect(apps).toHaveLength(2);
    expect(apps[0]).toBe(app);
    expect(apps[1]?.clock).toBe(clock);
    expect(cancelled).toEqual({ cancelled: true });
  });

  testWith(LeaseApplication, { instances: 0 }).fails(
    "instances must be a whole number ≥ 1",
    async ({ apps }) => {
      expect(apps).toHaveLength(0);
      await Promise.resolve();
    },
  );
});
