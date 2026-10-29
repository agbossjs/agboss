/**
 * #265 AC2, #481 AC3: `ExecutionTreeRepository` — the published execution tree contract
 * (`executionTreeContract`), run against the in-memory default (two instances over one database)
 * and `SqliteExecutionTreeRepository` (two instances on one file); then the same through an
 * application with two instances (not a store rule: it stays here).
 */
import { beforeEach, describe, expect } from "vitest";
import { InMemoryExecutionTreeRepository } from "../../src/infrastructure/execution-tree.repository.js";
import { SqliteExecutionTreeRepository } from "../../src/infrastructure/sqlite/sqlite-execution-tree.repository.js";
import { executionTreeContract } from "../../src/testing/contracts/index.js";
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
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";

describe("#481 AC3: the core's tree stores pass the published execution tree contract", () => {
  executionTreeContract(
    inMemoryTarget(({ database }) => new InMemoryExecutionTreeRepository(database)),
  );
  executionTreeContract(
    sqliteTarget(({ connection }) => new SqliteExecutionTreeRepository(connection())),
  );
});

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
