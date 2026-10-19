/**
 * #265 AC2: `ExecutionTreeRepository` — `saveIfAbsent` is atomic; the keys of a request are
 * visible to its whole tree on any instance, invisible to other requests, and removed when the
 * tree ends. One suite, run against the in-memory default (two instances over one database) and
 * `SqliteExecutionTreeRepository` (two instances on one file), then the same through an
 * application with two instances.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionContextUnavailableError } from "../../src/index.js";
import {
  InMemoryExecutionTreeRepository,
  type ExecutionTree,
  type ExecutionTreeRepository,
} from "../../src/infrastructure/execution-tree.repository.js";
import { SqliteExecutionTreeRepository } from "../../src/infrastructure/sqlite/sqlite-execution-tree.repository.js";
import { storeKinds } from "./contracts/store-kinds.js";
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

const tree: ExecutionTree = { tenantId: "default", rootExecutionId: "root-1" };
const otherRequest: ExecutionTree = { tenantId: "default", rootExecutionId: "root-2" };

const kinds = storeKinds<ExecutionTreeRepository>({
  inMemory: ({ database }) => new InMemoryExecutionTreeRepository(database),
  sqlite: ({ connection }) => new SqliteExecutionTreeRepository(connection()),
});

/** The two instances' repositories of one test. */
const pairOf = (
  twoInstances: (typeof kinds)[number]["twoInstances"],
): [ExecutionTreeRepository, ExecutionTreeRepository] => {
  const { first, second } = twoInstances();
  return [first, second];
};

describe.each(kinds)("#265 AC2: the contract ($name)", ({ twoInstances }) => {
  it("one true of two: two concurrent saves of one key, on two instances", async () => {
    const [first, second] = pairOf(twoInstances);

    const claimed = await Promise.all([
      first.saveIfAbsentInTree(tree, "subtopic:7", true),
      second.saveIfAbsentInTree(tree, "subtopic:7", true),
    ]);

    expect(claimed.filter(Boolean)).toHaveLength(1);
  });

  it("visible to the tree on any instance, invisible to other requests", async () => {
    const [first, second] = pairOf(twoInstances);

    await first.saveIfAbsentInTree(tree, "subtopic:7", { by: "researcher" });

    expect(await second.findByIdInTree(tree, "subtopic:7")).toEqual({ by: "researcher" });
    expect(await second.findByIdInTree(otherRequest, "subtopic:7")).toBeUndefined();
    expect(await second.saveIfAbsentInTree(otherRequest, "subtopic:7", true)).toBe(true);
  });

  it("removed at the end: deleting the tree removes its keys only", async () => {
    const [first, second] = pairOf(twoInstances);
    await first.saveIfAbsentInTree(tree, "subtopic:7", true);
    await first.saveIfAbsentInTree(otherRequest, "subtopic:7", true);

    await second.deleteAllInTree(tree);

    expect(await first.findByIdInTree(tree, "subtopic:7")).toBeUndefined();
    expect(await first.findByIdInTree(otherRequest, "subtopic:7")).toBe(true);
  });

  it("a value is a copy: changing the saved object changes nothing stored", async () => {
    const [first] = pairOf(twoInstances);
    const value = { topics: ["a"] };
    await first.saveIfAbsentInTree(tree, "plan", value);

    value.topics.push("b");

    expect(await first.findByIdInTree(tree, "plan")).toEqual({ topics: ["a"] });
  });

  it("a value comes back as JSON gives it: nested lists, objects, null", async () => {
    const [first, second] = pairOf(twoInstances);
    const value = { plan: ["a", 1, true, null], by: { agent: "researcher" } };

    await first.saveIfAbsentInTree(tree, "plan", value);

    expect(await second.findByIdInTree(tree, "plan")).toEqual(value);
  });

  it("saveIfAbsent / findById outside an execution throw ExecutionContextUnavailableError", async () => {
    const [first] = pairOf(twoInstances);

    await expect(async () => first.saveIfAbsent("k", true)).rejects.toThrow(
      ExecutionContextUnavailableError,
    );
    await expect(async () => first.findById("k")).rejects.toThrow(ExecutionContextUnavailableError);
  });
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
    const root = { tenantId: "default", rootExecutionId: paused.runId };
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

    const root = { tenantId: "default", rootExecutionId: paused.runId };
    expect(await seen.trees[0]?.findByIdInTree(root, "claim:x")).toBeUndefined();
  });
});
