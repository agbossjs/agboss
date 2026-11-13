/**
 * #807 (A2A P1, design §4.1.3, §4.1.5, §4.3.2): the core seams an A2A task stands on — a reserved
 * execution id (one execution per task, ever), a cancel of one execution tree by its root id
 * (never its thread's other runs; honoured before the run's record exists), a sweep's fence of a
 * reserved id, and where a tree is as its durable records say.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { DuplicateExecutionIdError } from "../../src/errors.js";
import { NotPausedError } from "../../src/run/resume-agent.js";
import { CANCEL_REQUEST_KEY } from "../../src/app/cancel-requests.js";
import {
  DurableExecutionStatus,
  ExecutionCancelOutcome,
  executionControlOf,
  type ExecutionControl,
} from "../../src/app/execution-control.js";
import { withReservedExecutionId } from "../../src/app/tree-control.js";
import { ExecutionTreeRepository } from "../../src/infrastructure/execution-tree.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { ExecutionStatus, type ExecutionOutput } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  Hold,
  levers,
  OrderWorkflowStart,
  ReceiptDto,
  RecoveryApplication,
  resetRecovery,
  seen,
  StampedExecutionRecordRepository,
  Step,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { MemorySaver } from "@langchain/langgraph";

const test = testWith(RecoveryApplication, { instances: 2 });
const THREAD = "t-1";
const TASK = "task-1";
const tree = (rootExecutionId = TASK) => ({
  tenantId: "default",
  rootExecutionId,
  threadId: THREAD,
});

beforeEach(resetRecovery);
afterEach(() => {
  vi.restoreAllMocks();
});

/** The two instances of a test, built. */
async function pair(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [first, second] = apps;
  if (first === undefined || second === undefined) throw new Error("the test runs two instances");
  await first.ready();
  await second.ready();
  return [first, second];
}

/** The instance's execution control (built by `createApp`). */
function controlOf(app: TestApp): ExecutionControl {
  const control = executionControlOf(app);
  if (control === undefined) throw new Error("the app has no execution control");
  return control;
}

/** Runs `OrderWorkflowStart` under the reserved `id` on `app`. */
const reserved = (app: TestApp, id = TASK, text = "go"): Promise<ExecutionOutput> =>
  execute(app, OrderWorkflowStart, { text }, withReservedExecutionId({ threadId: THREAD }, id));

/** A run started on an instance: its call, settled only when it ends. */
interface Started {
  readonly call: Promise<ExecutionOutput>;
}

/** Starts a run under `id` that steps and holds; resolves once it holds. */
async function holding(app: TestApp, id = TASK): Promise<Started> {
  const held = new Promise<void>((resolve) => {
    levers.holdStarted = resolve;
  });
  const call = reserved(app, id, "step, then hold");
  call.catch(() => undefined);
  await held;
  return { call };
}

const stepAndHold = [callTool(Step, { text: "one" }), callTool(Hold, { text: "a job" })] as const;
const done = replyWith(ReceiptDto, { text: "Done." });

const requestOf = (app: TestApp, rootExecutionId = TASK) =>
  app
    .resolve(ExecutionTreeRepository)
    .findByIdInTree({ tenantId: "default", rootExecutionId }, CANCEL_REQUEST_KEY);

describe("#807 AC1: a reserved execution id starts one execution, ever", () => {
  test("the run's id is the reserved one", async ({ apps, mockLlm }) => {
    mockLlm(Clerk).thenReturn(done);
    const [first] = await pair(apps);

    const result = await reserved(first);

    expect(result.executionId).toBe(TASK);
  });

  test("the same id again, on either instance, is DuplicateExecutionIdError: nothing runs", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Step, { text: "once" }), done);
    const [first, second] = await pair(apps);
    await reserved(first);

    await expect(reserved(first)).rejects.toBeInstanceOf(DuplicateExecutionIdError);
    await expect(reserved(second)).rejects.toBeInstanceOf(DuplicateExecutionIdError);
    expect(seen.steps).toEqual(["once"]);
  });

  test("two instances starting one id at once: one runs, the other is refused", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Step, { text: "once" }), done);
    const [first, second] = await pair(apps);

    const calls = await Promise.allSettled([reserved(first), reserved(second)]);

    expect(calls.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = calls.find((call) => call.status === "rejected");
    expect(refused?.reason).toBeInstanceOf(DuplicateExecutionIdError);
    expect(seen.steps).toEqual(["once"]);
  });

  test("an id that is no key's text is refused before any call, the id not echoed", () => {
    expect(() => withReservedExecutionId({}, "x\uD800")).toThrow(RangeError);
    expect(() => withReservedExecutionId({}, "x\uD800")).toThrow(
      /^a reserved execution id breaks the rule "[a-z-]+"$/u,
    );
    expect(() => withReservedExecutionId({}, "x\uD800")).not.toThrow(/x\uD800/u);
  });

  test("a sweep's fence wins: no execution ever starts under the id", async ({ apps }) => {
    const [first, second] = await pair(apps);

    const fenced = await controlOf(first).claimExecutionId({
      executionId: TASK,
      tenantId: "default",
    });
    const again = await controlOf(second).claimExecutionId({ executionId: TASK, tenantId: "acme" });

    expect([fenced, again]).toEqual([true, false]);
    await expect(reserved(second)).rejects.toBeInstanceOf(DuplicateExecutionIdError);
  });

  test("a start wins: the fence finds the id taken", async ({ apps, mockLlm }) => {
    mockLlm(Clerk).thenReturn(done);
    const [first, second] = await pair(apps);
    await reserved(first);

    expect(
      await controlOf(second).claimExecutionId({ executionId: TASK, tenantId: "default" }),
    ).toBe(false);
  });
});

describe("#807 AC2: a cancel of one execution tree", () => {
  test("running here: aborted, it rejects as cancelled", async ({ apps, mockLlm }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first] = await pair(apps);
    const { call } = await holding(first);
    const outcome = await controlOf(first).cancelExecution(tree());
    expect(outcome).toBe(ExecutionCancelOutcome.Aborted);
    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.errors.map((error) => error.constructor)).toEqual([ExecutionCancelledError]);
  });

  test("running on the other instance: requested, its holder stops within one renewal", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first, second] = await pair(apps);
    const { call } = await holding(first);

    const outcome = await controlOf(second).cancelExecution(tree());
    await clock.advance(seconds(10));

    expect(outcome).toBe(ExecutionCancelOutcome.Requested);
    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.steps).toEqual(["one"]);
  });

  test("another run of its thread is never touched: a thread cancel would stop it", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold, done);
    const [first, second] = await pair(apps);
    const { call } = await holding(first);

    // another task of the same context, not started
    const outcome = await controlOf(second).cancelExecution(tree("task-2"));
    levers.letGo?.();

    expect(outcome).toBe(ExecutionCancelOutcome.AwaitingStart);
    await expect(call).resolves.toMatchObject({ status: ExecutionStatus.Finished });
    expect(await requestOf(first, "task-2")).toBeDefined();
  });

  test("before it started: it stops before its first step when it starts", async ({ apps }) => {
    const [first, second] = await pair(apps);

    const outcome = await controlOf(second).cancelExecution(tree());
    const call = reserved(first);

    expect(outcome).toBe(ExecutionCancelOutcome.AwaitingStart);
    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.steps).toEqual([]);
    expect(seen.errors.map((error) => error.constructor)).toEqual([ExecutionCancelledError]);
  });

  test("paused: ended here as cancelled, its pause withdrawn — a later answer is refused", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const [first, second] = await pair(apps);
    const paused = await reserved(first);

    const outcome = await controlOf(second).cancelExecution(tree());

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(outcome).toBe(ExecutionCancelOutcome.Ended);
    await expect(first.resume(answerOf(paused, { approved: true }))).rejects.toBeInstanceOf(
      NotPausedError,
    );
    expect(seen.charges).toEqual([]);
    expect(await controlOf(first).executionStateOf(tree())).toEqual({
      status: DurableExecutionStatus.Cancelled,
    });
  });

  test("a cancel of another task of its context leaves a paused run paused", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }), done);
    const [first, second] = await pair(apps);
    const paused = await reserved(first);

    const outcome = await controlOf(second).cancelExecution(tree("task-2"));
    const resumed = await first.resume(answerOf(paused, { approved: true }));

    expect(outcome).toBe(ExecutionCancelOutcome.AwaitingStart);
    expect(resumed.status).toBe(ExecutionStatus.Finished);
    expect(seen.charges).toEqual(["10 USD"]);
  });

  test.for([
    // the state read looks once, the cancel once before it holds the lease, once after
    ["at its first look", 2],
    ["once it holds the lease", 3],
  ] as const)(
    "another run of its thread paused %s: left alone (review #1)",
    async ([, from], { apps, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
      const [first, second] = await pair(apps);
      const paused = await reserved(first);
      const find = Reflect.get(
        InMemoryPausedExecutionRepository.prototype,
        "findByTenantIdAndThreadId",
      );
      let reads = 0;
      // the state read and the cancel's first look see task-1; once the lease is held, the thread's
      // paused run is another execution's
      vi.spyOn(
        InMemoryPausedExecutionRepository.prototype,
        "findByTenantIdAndThreadId",
      ).mockImplementation(async function (
        this: InMemoryPausedExecutionRepository,
        tenantId,
        threadId,
      ) {
        reads += 1;
        const stored = await find.call(this, tenantId, threadId);
        if (reads < from || stored === undefined) return stored;
        return { ...stored, run: { ...stored.run, runId: "task-other" } };
      });

      const outcome = await controlOf(second).cancelExecution(tree());
      vi.restoreAllMocks();

      expect(outcome).toBe(ExecutionCancelOutcome.Requested);
      // nothing was dropped: the paused run and its pause are still there (an old drop by thread
      // would have withdrawn them); its own request stops it at the next take of its lease
      expect(await controlOf(first).executionStateOf(tree())).toMatchObject({
        status: DurableExecutionStatus.Paused,
        pending: [{ pauseId: paused.pending[0]?.pauseId }],
      });
      await expect(first.resume(answerOf(paused, { approved: true }))).rejects.toBeInstanceOf(
        ExecutionCancelledError,
      );
    },
  );

  test("over already: nothing cancelled, the request withdrawn", async ({ apps, mockLlm }) => {
    mockLlm(Clerk).thenReturn(done);
    const [first, second] = await pair(apps);
    await reserved(first);

    const outcome = await controlOf(second).cancelExecution(tree());

    expect(outcome).toBe(ExecutionCancelOutcome.AlreadyOver);
    expect(await requestOf(first)).toBeUndefined();
    expect(await controlOf(first).executionStateOf(tree())).toMatchObject({
      status: DurableExecutionStatus.Finished,
    });
  });

  test("its ids are keys' text: refused, never echoed, nothing saved", async ({ apps }) => {
    const [first] = await pair(apps);

    await expect(
      controlOf(first).cancelExecution({ ...tree(), rootExecutionId: "x\uD800" }),
    ).rejects.toMatchObject({ code: "dto.invalid" });
    await expect(
      controlOf(first).cancelExecution({ ...tree(), threadId: "x\uD800" }),
    ).rejects.toMatchObject({ code: "run.invalid-thread-id" });
    await expect(controlOf(first).cancelExecution({ ...tree(), ownerId: "" })).rejects.toThrow(
      /^invalid ExecutionCancelRequest: ownerId: /u,
    );
    expect(await requestOf(first)).toBeUndefined();
  });
});

describe("#807 AC2: what a cancel saves", () => {
  test("the request in the tree: when, and who asked — or nobody", async ({ apps, clock }) => {
    const [first, second] = await pair(apps);

    await controlOf(first).cancelExecution({ ...tree(), ownerId: "alice" });
    await controlOf(second).cancelExecution(tree("task-2"));

    expect(await requestOf(first)).toEqual({
      requestedAt: clock.now().toISOString(),
      ownerId: "alice",
    });
    expect(await requestOf(first, "task-2")).toEqual({
      requestedAt: clock.now().toISOString(),
      ownerId: null,
    });
  });
});

describe("#807 AC2: a cancel racing a resume — never both", () => {
  test("resumed first: the decision recorded, then the cancel stops the run", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }), done);
    const [first, second] = await pair(apps);
    const paused = await reserved(first);

    const resumed = await first.resume(answerOf(paused, { approved: true }));
    const outcome = await controlOf(second).cancelExecution(tree());

    expect(resumed.status).toBe(ExecutionStatus.Finished);
    expect(outcome).toBe(ExecutionCancelOutcome.AlreadyOver);
    expect(seen.charges).toEqual(["10 USD"]);
  });

  test("cancelled first: the resume is refused, nothing charged", async ({ apps, mockLlm }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const [first, second] = await pair(apps);
    const paused = await reserved(first);

    await controlOf(second).cancelExecution(tree());
    const resumed = first.resume(answerOf(paused, { approved: true }));

    await expect(resumed).rejects.toBeInstanceOf(NotPausedError);
    expect(seen.charges).toEqual([]);
  });

  test("cancelled while the resumed pass runs: it stops, no step after the cancel", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      callTool(Hold, { text: "after the charge" }),
      // nothing after: a model call once cancelled would find no script and fail the test
    );
    const [first, second] = await pair(apps);
    const paused = await reserved(first);
    const held = new Promise<void>((resolve) => {
      levers.holdStarted = resolve;
    });

    const resumed = first.resume(answerOf(paused, { approved: true }));
    resumed.catch(() => undefined);
    await held;
    const outcome = await controlOf(second).cancelExecution(tree());
    levers.letGo?.();

    expect(outcome).toBe(ExecutionCancelOutcome.Requested);
    await expect(resumed).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.charges).toEqual(["10 USD"]);
    expect(seen.steps).toEqual([]);
    expect(await controlOf(first).executionStateOf(tree())).toEqual({
      status: DurableExecutionStatus.Cancelled,
    });
  });
});

describe("#807 AC3: where a tree is, from its durable records", () => {
  test("not started, running, paused, finished — read on any instance", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold, callTool(Charge, { text: "5 USD" }), done);
    const [first, second] = await pair(apps);
    const states = controlOf(second);

    const before = await states.executionStateOf(tree());
    const { call } = await holding(first);
    const running = await states.executionStateOf(tree());
    levers.letGo?.();
    const paused = await call;
    const waiting = await states.executionStateOf(tree());
    const resumed = await first.resume(answerOf(paused, { approved: true }));
    const finished = await states.executionStateOf(tree());

    expect(before).toEqual({ status: DurableExecutionStatus.NotStarted });
    expect(running).toEqual({ status: DurableExecutionStatus.Running });
    expect(waiting).toMatchObject({
      status: DurableExecutionStatus.Paused,
      pending: [{ pauseId: paused.pending[0]?.pauseId, channel: expect.any(String) as string }],
    });
    expect(finished).toEqual({
      status: DurableExecutionStatus.Finished,
      finish: "receipt-workflow-finish",
      output: { text: "Done." },
      // #844: what the tree spent, as its end said it — read from its records
      spentUsd: resumed.spend.totalUsd,
    });
  });

  test("a run whose record is out of reach is running while its checkpoint shows it began", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold, done);
    const [first, second] = await pair(apps);
    const { call } = await holding(first);
    vi.spyOn(
      StampedExecutionRecordRepository.prototype,
      "findByTenantIdAndRunId",
    ).mockResolvedValue(undefined);

    const state = await controlOf(second).executionStateOf(tree());
    vi.restoreAllMocks();
    levers.letGo?.();
    await call;

    expect(state).toEqual({ status: DurableExecutionStatus.Running });
  });

  test("a finished record whose checkpoint is gone reads running, never not started", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(done);
    const [first, second] = await pair(apps);
    await reserved(first);
    vi.spyOn(MemorySaver.prototype, "getTuple").mockResolvedValue(undefined);

    const state = await controlOf(second).executionStateOf(tree());

    expect(state).toEqual({ status: DurableExecutionStatus.Running });
  });

  test("a record a guard stopped is a failure with its reason", async ({ apps }) => {
    const [first] = await pair(apps);
    const guarded = {
      id: "r-1",
      runId: TASK,
      threadId: THREAD,
      tenantId: "default",
      status: "guarded",
      stopReason: "blocked by a guardrail",
    };
    vi.spyOn(
      StampedExecutionRecordRepository.prototype,
      "findByTenantIdAndRunId",
    ).mockResolvedValue(guarded as never);

    expect(await controlOf(first).executionStateOf(tree())).toEqual({
      status: DurableExecutionStatus.Failed,
      reason: "blocked by a guardrail",
    });
  });

  test("a store that does not answer fails the read, never reads as not started", async ({
    apps,
  }) => {
    const [first] = await pair(apps);
    vi.spyOn(
      InMemoryPausedExecutionRepository.prototype,
      "findByTenantIdAndThreadId",
    ).mockRejectedValue(new Error("the pause store does not answer"));

    await expect(controlOf(first).executionStateOf(tree())).rejects.toThrow(
      "the pause store does not answer",
    );
  });

  test("a failure, with its record's reason", async ({ apps, mockLlm }) => {
    mockLlm(Clerk).thenReturn(callTool(Step, { text: "one" }));
    const [first, second] = await pair(apps);
    await expect(reserved(first)).rejects.toThrow();

    expect(await controlOf(second).executionStateOf(tree())).toMatchObject({
      status: DurableExecutionStatus.Failed,
      reason: expect.any(String) as string,
    });
  });
});
