/**
 * #313 AC2: every thread id and execution id the framework mints comes from the application's
 * `IdGenerator`. Under `testWith` they are deterministic — `thread-1`, `execution-1`, … per test,
 * the root before its child; a listed generator (`PrefixedIdGenerator`) replaces the default in
 * `createApp` and in `testWith`; the built-in default keeps the formats (random UUIDs). A `pauseId`
 * never comes from it: a random 128-bit token in every case.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { createApp } from "../../src/application/create-app.js";
import { ExecutionStatus } from "../../src/app/types.js";
import type { App, ExecutionOutput } from "../../src/index.js";
import { SequentialIdGenerator, testWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { callTool, replyWith, type ModelRequest } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ChildRefundAgent,
  SingleChildWorkflowFinish,
  SingleChildWorkflowStart,
} from "../channels/fixtures/child-pauses.workflow.js";
import { approve, orderOf } from "../channels/fixtures/pause-scripts.js";
import {
  ConfirmOrderTool,
  RefundDoneDto,
  resetPauses,
} from "../channels/fixtures/pauses.workflow.js";
import {
  BuiltInIdsApplication,
  ContextGeneratorApplication,
  GeneratorInWorkflowApplication,
  PrefixedIdsApplication,
  TwoGeneratorsApplication,
} from "./fixtures/id-generators.workflow.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAUSE_ID = /^[0-9a-f]{32}$/;
const THREAD = /^thr_[0-9a-f-]{36}$/;
const EXECUTION = /^exe_[0-9a-f-]{36}$/;

beforeEach(resetPauses);

/** The child's agent: the customer confirms the order first (a pause), then it answers. */
const confirmer = (request: ModelRequest) =>
  request.kind === "chat" && request.messages.some((line) => line.role === "tool")
    ? replyWith(RefundDoneDto, { orderId: orderOf(request) })
    : callTool(ConfirmOrderTool, { orderId: orderOf(request) });

/** The ids one paused-then-resumed run shows: its thread, root, child and pause. */
interface RunIds {
  readonly threadId: string;
  readonly rootExecutionId: string;
  readonly childExecutionId: string | undefined;
  readonly pauseId: string | undefined;
}

/** Runs one order through the single-child workflow: the child pauses, the answer finishes it. */
async function pausedAndResumed(
  app: Pick<App, "execute" | "resume">,
): Promise<{ ids: RunIds; done: ExecutionOutput }> {
  const paused = await execute(app, SingleChildWorkflowStart, { orderId: "A" });
  expect(paused.status).toBe(ExecutionStatus.Paused);
  const [pause] = paused.pending;
  const done = await app.resume({ pauseId: pause?.pauseId ?? "", decision: approve });
  expect(done).toFinishWith(SingleChildWorkflowFinish, { orderId: "A" });
  const ids = {
    threadId: paused.threadId,
    rootExecutionId: paused.executionId,
    childExecutionId: pause?.childExecutionId,
    pauseId: pause?.pauseId,
  };
  return { ids, done };
}

/** A `createApp` instance of `application`, the child's agent scripted. */
async function scriptedApp(application: typeof PrefixedIdsApplication): Promise<App> {
  const book = new ScriptBook();
  book.scriptOf("agent:child-refund-agent").thenAnswer(confirmer);
  return createApp(application, { gateway: createScriptedGateway(book) });
}

describe("#313 AC2: under testWith the ids are deterministic", () => {
  const test = testWith(BuiltInIdsApplication);

  test("thread-1 / execution-1 for the root, execution-2 for its child; the pauseId stays random", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ChildRefundAgent).thenAnswer(confirmer);

    const { ids, done } = await pausedAndResumed(app);

    expect(ids).toEqual({
      threadId: "thread-1",
      rootExecutionId: "execution-1",
      childExecutionId: "execution-2",
      pauseId: expect.stringMatching(PAUSE_ID),
    });
    expect(done.children.map((child) => child.executionId)).toEqual(["execution-2"]);
  });

  test("each new thread and execution takes the next number; a caller's own threadId is used as given", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ChildRefundAgent).thenAnswer(confirmer);

    const first = await pausedAndResumed(app);
    const second = await pausedAndResumed(app);
    const own = await execute(
      app,
      SingleChildWorkflowStart,
      { orderId: "A" },
      { threadId: "order-a" },
    );

    expect([first.ids.threadId, second.ids.threadId, own.threadId]).toEqual([
      "thread-1",
      "thread-2",
      "order-a",
    ]);
    expect([first.ids.rootExecutionId, second.ids.rootExecutionId, own.executionId]).toEqual([
      "execution-1",
      "execution-3",
      "execution-5",
    ]);
    expect(own.pending[0]?.childExecutionId).toBe("execution-6");
  });

  test("the sequence starts again in every test", async ({ app, mockLlm }) => {
    mockLlm(ChildRefundAgent).thenAnswer(confirmer);

    const { ids } = await pausedAndResumed(app);

    expect([ids.threadId, ids.rootExecutionId]).toEqual(["thread-1", "execution-1"]);
  });
});

describe("#313 AC2: a listed generator replaces the default", () => {
  const test = testWith(PrefixedIdsApplication);

  test("in testWith: the application's PrefixedIdGenerator, not the sequential one", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ChildRefundAgent).thenAnswer(confirmer);

    const { ids } = await pausedAndResumed(app);

    expect(ids).toEqual({
      threadId: expect.stringMatching(THREAD),
      rootExecutionId: expect.stringMatching(EXECUTION),
      childExecutionId: expect.stringMatching(EXECUTION),
      pauseId: expect.stringMatching(PAUSE_ID),
    });
  });

  it("in createApp: thr_… / exe_… for the thread, the root and the child; the pauseId is not its", async () => {
    const app = await scriptedApp(PrefixedIdsApplication);
    try {
      const { ids, done } = await pausedAndResumed(app);

      expect(ids).toEqual({
        threadId: expect.stringMatching(THREAD),
        rootExecutionId: expect.stringMatching(EXECUTION),
        childExecutionId: expect.stringMatching(EXECUTION),
        pauseId: expect.stringMatching(PAUSE_ID),
      });
      expect(ids.childExecutionId).not.toBe(ids.rootExecutionId);
      expect(done.children.map((child) => child.executionId)).toEqual([ids.childExecutionId]);
    } finally {
      await app.close();
    }
  });

  it("in createApp without one: the built-in RandomIdGenerator — the formats unchanged (UUIDs)", async () => {
    const app = await scriptedApp(BuiltInIdsApplication);
    try {
      const { ids } = await pausedAndResumed(app);

      expect(ids).toEqual({
        threadId: expect.stringMatching(UUID),
        rootExecutionId: expect.stringMatching(UUID),
        childExecutionId: expect.stringMatching(UUID),
        pauseId: expect.stringMatching(PAUSE_ID),
      });
    } finally {
      await app.close();
    }
  });

  it("SequentialIdGenerator counts threads and executions apart, from 1", () => {
    const generator = new SequentialIdGenerator();

    expect([
      generator.newThreadId(),
      generator.newExecutionId(),
      generator.newExecutionId(),
      generator.newThreadId(),
    ]).toEqual(["thread-1", "execution-1", "execution-2", "thread-2"]);
  });
});

describe("#313: the IdGenerator is infrastructure", () => {
  it("two listed generators: [di.ambiguous-implementation], naming both", async () => {
    await expect(scriptedApp(TwoGeneratorsApplication)).rejects.toThrow(
      /\[di\.ambiguous-implementation\].*IdGenerator.*PrefixedIdGenerator.*OtherIdGenerator/,
    );
  });

  it("one that injects a context fails the start: it is created before the stores and the contexts", async () => {
    await expect(scriptedApp(ContextGeneratorApplication)).rejects.toThrow(
      "InstanceIdGenerator cannot depend on the application's contexts: the IdGenerator is created before the stores that inject it",
    );
  });

  it("in a workflow's providers: [di.infrastructure-in-workflow]", async () => {
    await expect(applicationOf(GeneratorInWorkflowApplication)).rejects.toThrow(
      "[di.infrastructure-in-workflow] PrefixedIdGenerator extends IdGenerator — infrastructure is listed only in @Application({ providers }), not in echo-workflow's providers",
    );
  });
});
