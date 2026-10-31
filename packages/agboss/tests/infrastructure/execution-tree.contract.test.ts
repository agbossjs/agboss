/**
 * #265 AC2: `ExecutionTreeRepository` through an application with two instances (not a store rule:
 * it stays here). The published execution tree contract runs on the core's stores through
 * `storeConformance` (#526, store-conformance.*.test.ts).
 */
import { beforeEach, describe, expect } from "vitest";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute, answerOf } from "../helpers/flow.js";
import {
  Charge,
  Claim,
  Clerk,
  LeaseApplication,
  OrderWorkflowStart,
  ReceiptDto,
  Recall,
  resetLease,
  seen,
} from "./fixtures/lease.workflow.js";

const test = testWith(LeaseApplication, { instances: 2 });

beforeEach(resetLease);

describe("#265 AC2: the keys of a request through the application", () => {
  test("visible to the tree after a pause resumed on the other instance, removed when it finishes", async ({
    app,
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Claim, { text: "x" }),
      callTool(Charge, { text: "10 USD" }),
      callTool(Claim, { text: "x" }),
      callTool(Recall, { text: "x" }),
      replyWith(ReceiptDto, { text: "Done." }),
    );
    const paused = await execute(app, OrderWorkflowStart, { text: "claim, charge, claim" });

    await apps[1]?.resume(answerOf(paused, { approved: true }));

    expect(seen.claims).toEqual([true, false]);
    expect(seen.recalls).toEqual([true]);
    const rows = seen.trees[0];
    const root = { tenantId: "default", rootExecutionId: paused.executionId };
    expect(await rows?.findByIdInTree(root, "claim:x")).toBeUndefined();
  });

  test("invisible to another request: the same key is claimed again", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Claim, { text: "x" }),
      replyWith(ReceiptDto, { text: "One." }),
      callTool(Claim, { text: "x" }),
      replyWith(ReceiptDto, { text: "Two." }),
    );

    await execute(app, OrderWorkflowStart, { text: "claim" });
    await execute(app, OrderWorkflowStart, { text: "claim again" });

    expect(seen.claims).toEqual([true, true]);
  });

  test("a cancelled paused tree loses its keys", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(callTool(Claim, { text: "x" }), callTool(Charge, { text: "1 USD" }));
    const paused = await execute(app, OrderWorkflowStart, { text: "claim, charge" });

    await app.cancel(paused.threadId);

    const root = { tenantId: "default", rootExecutionId: paused.executionId };
    expect(await seen.trees[0]?.findByIdInTree(root, "claim:x")).toBeUndefined();
  });
});
