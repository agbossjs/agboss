/**
 * #591 — an `IdGenerator` that repeats an execution id never makes two trees one: every new
 * execution's id — a root, a child, a recursion level (here or on any instance) — is kept by the
 * lease store before anything of it is written (`saveExecutionIdIfAbsent`), and an id any earlier
 * execution had, of a tree running, paused, finished or cancelled, is `DuplicateExecutionIdError`
 * (`run.duplicate-execution-id`: the generator named, never the id). A resume and a recovery keep
 * their id: they are not a create.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { DuplicateExecutionIdError } from "../../src/errors.js";
import { ExecutionRecordRepository, ExecutionRecordStatus, type App } from "../../src/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  ChildRefundAgent,
  SingleChildWorkflowStart,
} from "../channels/fixtures/child-pauses.workflow.js";
import { approve, orderOf } from "../channels/fixtures/pause-scripts.js";
import {
  ConfirmOrderTool,
  RefundDoneDto,
  resetPauses,
} from "../channels/fixtures/pauses.workflow.js";
import {
  CountdownWorkflowStart,
  resetRecursionLog,
} from "../flow/runtime/fixtures/recursion.workflow.js";
import { RemoteCountdownWorkflowStart } from "../flow/runtime/fixtures/remote-recursion.workflow.js";
import { TestExecutionBudget } from "../flow/fixtures/budgets.js";
import { minting, resetMinting } from "./fixtures/minted-ids.application.js";
import { RepeatedIdsApplication } from "./fixtures/repeated-ids.application.js";

const test = testWith(RepeatedIdsApplication);
const twice = testWith(RepeatedIdsApplication, { instances: 2 });

beforeEach(() => {
  resetMinting();
  resetPauses();
  resetRecursionLog();
});

/** What `call` rejected with (`undefined`: it did not). */
const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

/** The `DuplicateExecutionIdError` in `error`'s cause chain (or `error` itself). */
function duplicateIn(error: unknown): unknown {
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    if (at instanceof DuplicateExecutionIdError) return at;
  }
  return error;
}

/** The refusal names the generator, never the id. */
function expectRefused(error: unknown, id: string): void {
  const refused = duplicateIn(error);
  expect(refused).toBeInstanceOf(DuplicateExecutionIdError);
  expect(refused).toMatchObject({
    code: "run.duplicate-execution-id",
    generator: "PlannedIdGenerator",
  });
  expect((refused as Error).message).toContain("PlannedIdGenerator.newExecutionId()");
  expect((refused as Error).message).not.toContain(id);
  expect(JSON.stringify((refused as DuplicateExecutionIdError).details)).not.toContain(id);
  if (error !== refused) expect(String(error)).not.toContain(id);
}

/** The child's agent: the customer confirms the order first (a pause), then it answers. */
const confirmer = (request: ModelRequest) =>
  request.kind === "chat" && request.messages.some((line) => line.role === "tool")
    ? replyWith(RefundDoneDto, { orderId: orderOf(request) })
    : callTool(ConfirmOrderTool, { orderId: orderOf(request) });

/** A finished root under `id`: a countdown that ends on its first level. */
async function finishedRoot(app: Pick<App, "execute">, id: string): Promise<void> {
  minting.executions = [id];
  const done = await execute(app, CountdownWorkflowStart, { left: 0 });
  expect(done).toMatchObject({ status: ExecutionStatus.Finished, executionId: id });
}

/** The root executions still `running`: what a recovery would continue. */
const runningRoots = (app: Pick<App, "resolve">) =>
  app.resolve(ExecutionRecordRepository).findByStatus(ExecutionRecordStatus.Running, 100);

describe("#591: a repeated root id is refused before anything of the new tree is written", () => {
  test("after the first tree finished: refused; its lease log is untouched; the next id runs", async ({
    app,
  }) => {
    await finishedRoot(app, "order-tree-7");
    const tree = { tenantId: "default", rootExecutionId: "order-tree-7" };
    const logBefore = await app.leaseEventsOf(tree);
    minting.executions = ["order-tree-7"];

    const refused = await rejectionOf(execute(app, CountdownWorkflowStart, { left: 0 }));

    expectRefused(refused, "order-tree-7");
    expect(await app.leaseEventsOf(tree)).toEqual(logBefore);
    const next = await execute(app, CountdownWorkflowStart, { left: 0 });
    expect(next.status).toBe(ExecutionStatus.Finished);
    expect(next.executionId).not.toBe("order-tree-7");
  });

  test("while the first tree is paused: its root's and its child's ids are refused as roots; the paused tree resumes to its own finish", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ChildRefundAgent).thenAnswer(confirmer);
    minting.executions = ["root-p", "child-p"];
    const paused = await execute(app, SingleChildWorkflowStart, { orderId: "A" });
    minting.executions = ["root-p", "child-p"];

    const asRoot = await rejectionOf(execute(app, SingleChildWorkflowStart, { orderId: "B" }));
    const asChild = await rejectionOf(execute(app, SingleChildWorkflowStart, { orderId: "C" }));
    const done = await app.resume({ pauseId: paused.pending[0]?.pauseId ?? "", decision: approve });

    expectRefused(asRoot, "root-p");
    expectRefused(asChild, "child-p");
    expect(done).toMatchObject({ status: ExecutionStatus.Finished, executionId: "root-p" });
    expect(mockLlm(ChildRefundAgent).requests.map(orderOf)).toEqual(["A", "A"]);
  });

  test("after the first tree was cancelled: its root's and its child's ids are refused", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ChildRefundAgent).thenAnswer(confirmer);
    minting.executions = ["root-c", "child-c"];
    const paused = await execute(app, SingleChildWorkflowStart, { orderId: "A" });
    await app.cancel(paused.threadId);
    minting.executions = ["root-c", "child-c"];

    const asRoot = await rejectionOf(execute(app, CountdownWorkflowStart, { left: 0 }));
    const asChild = await rejectionOf(execute(app, CountdownWorkflowStart, { left: 0 }));

    expectRefused(asRoot, "root-c");
    expectRefused(asChild, "child-c");
  });

  test("a create that fails after its id was kept (a budget's maxSpend() throws): the id stays taken, nothing is left to recover, a new id runs", async ({
    app,
    mockOf,
  }) => {
    mockOf(TestExecutionBudget)
      .maxSpend.mockResolvedValue(usd(1000))
      .mockRejectedValueOnce(new Error("billing is down"));
    minting.executions = ["half-made", "half-made"];

    const crashed = await rejectionOf(execute(app, CountdownWorkflowStart, { left: 0 }));
    const repeated = await rejectionOf(execute(app, CountdownWorkflowStart, { left: 0 }));

    expect(crashed).toBeInstanceOf(Error);
    expect(duplicateIn(crashed)).not.toBeInstanceOf(DuplicateExecutionIdError);
    expectRefused(repeated, "half-made");
    expect(await runningRoots(app)).toEqual([]);
    expect((await execute(app, CountdownWorkflowStart, { left: 0 })).status).toBe(
      ExecutionStatus.Finished,
    );
  });
});

describe("#591: a child's or a level's id colliding with another execution fails its launch before it starts", () => {
  test("a child whose id is an earlier root's: the launch fails with the refusal, the child's agent is never called", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ChildRefundAgent).thenAnswer(confirmer);
    await finishedRoot(app, "tree-a");
    minting.executions = ["root-b", "tree-a"];

    const failed = await rejectionOf(execute(app, SingleChildWorkflowStart, { orderId: "B" }));

    expectRefused(failed, "tree-a");
    expect(mockLlm(ChildRefundAgent).requests).toHaveLength(0);
  });

  test("a recursion level whose id is its own root's, or an earlier tree's level: refused", async ({
    app,
  }) => {
    minting.executions = ["level-root", "level-root"];
    const ownRoot = await rejectionOf(execute(app, CountdownWorkflowStart, { left: 1 }));
    minting.executions = ["tree-1", "tree-1-level-2"];
    const first = await execute(app, CountdownWorkflowStart, { left: 1 });
    minting.executions = ["tree-2", "tree-1-level-2"];

    const earlierLevel = await rejectionOf(execute(app, CountdownWorkflowStart, { left: 1 }));

    expectRefused(ownRoot, "level-root");
    expect(first.status).toBe(ExecutionStatus.Finished);
    expectRefused(earlierLevel, "tree-1-level-2");
  });

  twice(
    "a level on any instance whose id is an earlier root's: refused before it is queued",
    async ({ apps }) => {
      const [app] = apps;
      if (app === undefined) throw new Error("the test runs no instance");
      await finishedRoot(app, "tree-a");
      minting.executions = ["remote-root", "tree-a"];

      const failed = await rejectionOf(execute(app, RemoteCountdownWorkflowStart, { left: 1 }));

      expectRefused(failed, "tree-a");
    },
  );
});

describe("#591: one id minted at once on two instances", () => {
  twice("exactly one tree runs under it; the other is refused", async ({ apps }) => {
    const [first, second] = apps;
    if (first === undefined || second === undefined) throw new Error("two instances expected");
    minting.executions = ["same-id", "same-id"];

    const outcomes = await Promise.all([
      rejectionOf(execute(first, CountdownWorkflowStart, { left: 0 })),
      rejectionOf(execute(second, CountdownWorkflowStart, { left: 0 })),
    ]);

    expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1);
    expectRefused(
      outcomes.find((outcome) => outcome !== undefined),
      "same-id",
    );
  });
});
