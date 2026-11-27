import { A2AError } from "../../../src/core/error-families/remote-errors.js";
/**
 * #1366 (shard `cancel-x-runs`): the wait for a remote task on its own — its signal is the caller's until the
 * wait is over, the deadline on the `Clock` aborts it and asks the remote to cancel (bounded), the events and
 * the polls it takes settle it only when the task's state does.
 */
import { TaskState, type StreamResponse, type Task } from "@a2a-js/sdk";
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { A2ACancelOutcome } from "../../../src/a2a/client/a2a-task-errors.js";
import { CANCEL_TIMEOUT, Waiter, type TaskWait } from "../../../src/a2a/client/a2a-waiter.js";
import type { Milliseconds } from "../../../src/units/index.js";

const taskOf = (state: TaskState, overrides: Partial<Task> = {}): Task => ({
  id: "t-1",
  contextId: "c-1",
  status: { state, message: undefined, timestamp: undefined },
  artifacts: [],
  history: [],
  metadata: undefined,
  ...overrides,
});
const WORKING = taskOf(TaskState.TASK_STATE_WORKING);

/** A clock whose sleeps end when told, or when their signal aborts (as a real one's do). */
function clockOf(now = new Date("2026-01-01T00:00:10.000Z")) {
  const sleeps: { delay: number; end: () => void }[] = [];
  const clock = {
    now: () => now,
    sleep: vi.fn((delay: number, signal?: AbortSignal) => {
      return new Promise<void>((resolve, reject) => {
        const end = (): void => {
          resolve();
        };
        sleeps.push({ delay, end });
        // a deadline already past: the sleep of none ends at once
        if (delay === 0) end();
        signal?.addEventListener(
          "abort",
          () => {
            reject(signal.reason as Error);
          },
          { once: true },
        );
      });
    }),
  };
  return { clock, sleeps };
}

function waitOf(overrides: Partial<TaskWait> = {}) {
  const { clock, sleeps } = clockOf();
  const cancelTask = vi.fn((_request: unknown, _options: unknown) => Promise.resolve(WORKING));
  const wait: TaskWait = {
    agent: "peer-agent",
    client: {
      getTask: vi.fn(() => Promise.resolve(WORKING)),
      resubscribeTask: vi.fn(),
      cancelTask,
    },
    clock,
    taskId: "t-1",
    task: WORKING,
    isStreaming: false,
    deadlineAt: undefined,
    signal: undefined,
    onEvent: undefined,
    ...overrides,
  };
  return { wait, clock, sleeps, cancelTask, waiter: new Waiter(wait) };
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("#1366: the wait's own signal", () => {
  it("follows the caller's: aborted with the caller's reason, now or later", () => {
    const caller = new AbortController();
    const { waiter } = waitOf({ signal: caller.signal });
    expect(waiter.signal.aborted).toBe(false);

    const reason = new Error("the caller left");
    caller.abort(reason);

    expect(waiter.signal.aborted).toBe(true);
    expect(waiter.signal.reason).toBe(reason);

    const early = new AbortController();
    early.abort(new Error("already"));
    expect(waitOf({ signal: early.signal }).waiter.signal.reason).toBe(early.signal.reason);
  });

  it("a caller that never aborts leaves the wait alone", () => {
    const { waiter } = waitOf();

    expect(waiter.signal.aborted).toBe(false);
  });

  it("close ends the wait's own sleep with `the wait ended` and stops following the caller", () => {
    const caller = new AbortController();
    const { waiter } = waitOf({ signal: caller.signal });

    waiter.close();

    expect(waiter.signal.aborted).toBe(true);
    expect((waiter.signal.reason as Error).message).toBe("the wait ended");
    caller.abort(new Error("late"));
    expect((waiter.signal.reason as Error).message).toBe("the wait ended");
  });

  it("close of a wait with no caller signal is as good", () => {
    const { waiter } = waitOf();

    waiter.close();

    expect(waiter.signal.aborted).toBe(true);
  });

  it("aborted: the caller's reason is thrown as it is", async () => {
    const caller = new AbortController();
    const { waiter } = waitOf({ signal: caller.signal });
    const reason = new Error("the caller left");
    caller.abort(reason);

    await expect(waiter.aborted()).rejects.toBe(reason);
  });

  it("abortedPromise rejects with the wait's reason, once its signal aborts — or at once when it has", async () => {
    const caller = new AbortController();
    const { waiter } = waitOf({ signal: caller.signal });
    const later = waiter.abortedPromise();
    const reason = new Error("stopped");
    caller.abort(reason);
    await expect(later).rejects.toBe(reason);

    await expect(waiter.abortedPromise()).rejects.toBe(reason);
  });
});

describe("#1366: the deadline", () => {
  it("no deadline: no sleep is armed", () => {
    const { waiter, clock } = waitOf();

    waiter.armDeadline();

    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("the sleep is what is left to the deadline on the Clock; a deadline in the past is a sleep of none", () => {
    const left = waitOf({ deadlineAt: new Date("2026-01-01T00:00:12.500Z") });
    left.waiter.armDeadline();
    expect(left.sleeps[0]?.delay).toBe(2500);
    expect(left.clock.sleep.mock.calls[0]?.[1]).toBe(left.waiter.signal);

    const past = waitOf({ deadlineAt: new Date("2025-01-01T00:00:00.000Z") });
    past.waiter.armDeadline();
    expect(past.sleeps[0]?.delay).toBe(0);
  });

  it("at the deadline the wait's signal aborts and its error is the deadline's, with how the cancel went", async () => {
    const { waiter, sleeps, cancelTask } = waitOf({
      deadlineAt: new Date("2026-01-01T00:00:12.000Z"),
      task: taskOf(TaskState.TASK_STATE_WORKING, { contextId: "c-9" }),
    });
    cancelTask.mockResolvedValue(taskOf(TaskState.TASK_STATE_CANCELED));
    waiter.armDeadline();

    sleeps[0]?.end();
    await turn();
    expect(waiter.signal.aborted).toBe(true);
    const error = await waiter.aborted().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(A2AError.Deadline);
    expect(error).toMatchObject({
      agent: "peer-agent",
      taskId: "t-1",
      contextId: "c-9",
      deadlineAt: new Date("2026-01-01T00:00:12.000Z"),
      cancel: A2ACancelOutcome.Cancelled,
      isCancelled: true,
      details: { deadlineAt: "2026-01-01T00:00:12.000Z" },
    });
    expect(cancelTask).toHaveBeenCalledOnce();
    expect(cancelTask.mock.calls[0]?.[0]).toEqual({ tenant: "", id: "t-1", metadata: undefined });
  });

  it("a sleep that is cut short (the wait's signal aborted first) still fires the abort, never unarmed", async () => {
    const caller = new AbortController();
    const { waiter } = waitOf({
      signal: caller.signal,
      deadlineAt: new Date("2026-01-01T00:00:12.000Z"),
    });
    waiter.armDeadline();

    caller.abort(new Error("the caller left"));
    await turn();

    expect((waiter.signal.reason as Error).message).toBe("the caller left");
  });

  it("only this task's CANCELED answer is its cancel; another state, another task, a refusal, no answer", async () => {
    const run = async (answer: () => Promise<Task>) => {
      const { waiter, cancelTask } = waitOf({ deadlineAt: new Date(0) });
      cancelTask.mockImplementation(answer);
      waiter.armDeadline();
      await turn();
      return waiter.aborted().catch((thrown: unknown) => thrown);
    };

    expect(await run(() => Promise.resolve(taskOf(TaskState.TASK_STATE_WORKING)))).toMatchObject({
      cancel: A2ACancelOutcome.NotCancelled,
      isCancelled: false,
    });
    expect(
      await run(() => Promise.resolve(taskOf(TaskState.TASK_STATE_CANCELED, { id: "other" }))),
    ).toMatchObject({ cancel: A2ACancelOutcome.NotCancelled });
    expect(await run(() => Promise.reject(new Error("not cancelable")))).toMatchObject({
      cancel: A2ACancelOutcome.Refused,
    });
  });

  it("a cancel nobody answers is bounded by CANCEL_TIMEOUT on the Clock, and the cancel's own request is aborted after", async () => {
    const { waiter, cancelTask, sleeps, clock } = waitOf({
      deadlineAt: new Date("2026-01-01T00:00:10.000Z"),
    });
    let requestSignal: AbortSignal | undefined;
    cancelTask.mockImplementation((_request, options) => {
      requestSignal = (options as { signal: AbortSignal }).signal;
      return new Promise<Task>(() => undefined);
    });
    waiter.armDeadline();
    await turn();

    const ended = waiter.aborted().catch((thrown: unknown) => thrown);
    await turn();
    const bound = sleeps.find((one) => one.delay === CANCEL_TIMEOUT);
    expect(bound).toBeDefined();
    expect(clock.sleep.mock.calls.at(-1)?.[1]).toBe(requestSignal);
    bound?.end();
    const error = await ended;

    expect(error).toMatchObject({ cancel: A2ACancelOutcome.NoAnswer });
    expect(requestSignal?.aborted).toBe(true);
    expect((requestSignal?.reason as Error).message).toBe("the cancel is over");
  });

  it("the context of the error is the task last seen's, else the cancel answer's, else none; an unsafe id is none", async () => {
    const run = async (task: Task | undefined, answer: Task) => {
      const { waiter, cancelTask } = waitOf({ deadlineAt: new Date(0), task });
      cancelTask.mockResolvedValue(answer);
      waiter.armDeadline();
      await turn();
      return waiter.aborted().catch((thrown: unknown) => thrown);
    };

    expect(
      await run(undefined, taskOf(TaskState.TASK_STATE_WORKING, { contextId: "c-from-cancel" })),
    ).toMatchObject({
      contextId: "c-from-cancel",
    });
    expect(
      await run(
        taskOf(TaskState.TASK_STATE_WORKING, { contextId: "c-seen" }),
        taskOf(TaskState.TASK_STATE_WORKING, { contextId: "c-from-cancel" }),
      ),
    ).toMatchObject({
      contextId: "c-seen",
    });
    expect(
      await run(taskOf(TaskState.TASK_STATE_WORKING, { contextId: "bad id!" }), WORKING),
    ).toMatchObject({
      contextId: "",
    });
  });
});

describe("#1366: the events and polls the wait takes", () => {
  const event = (payload: StreamResponse["payload"]): StreamResponse => ({ payload });

  it("a stream event of the task: reported to onEvent, the task returned only once it is settled", () => {
    const onEvent = vi.fn();
    const { waiter } = waitOf({ onEvent, task: undefined });

    const working = event({ $case: "task", value: WORKING });
    expect(waiter.take(working)).toBeUndefined();
    const done = event({ $case: "task", value: taskOf(TaskState.TASK_STATE_COMPLETED) });
    expect(waiter.take(done)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(1, working);
    expect(onEvent).toHaveBeenNthCalledWith(2, done);
  });

  it("an interrupted task settles the wait too; an event before any task changes nothing", () => {
    const { waiter } = waitOf({ task: undefined });

    expect(
      waiter.take(
        event({
          $case: "statusUpdate",
          value: {
            taskId: "t-1",
            contextId: "c-1",
            status: {
              state: TaskState.TASK_STATE_COMPLETED,
              message: undefined,
              timestamp: undefined,
            },
            metadata: undefined,
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      waiter.take(event({ $case: "task", value: taskOf(TaskState.TASK_STATE_INPUT_REQUIRED) })),
    ).toBeDefined();
  });

  it("an event of another task is a malformed answer, never taken", () => {
    const onEvent = vi.fn();
    const { waiter } = waitOf({ onEvent });

    expect(() =>
      waiter.take(
        event({ $case: "task", value: taskOf(TaskState.TASK_STATE_COMPLETED, { id: "other" }) }),
      ),
    ).toThrow(A2AError.Remote);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("a polled task is reported when it is the first, or its state or its artifacts changed — and only then", () => {
    const onEvent = vi.fn();
    const { waiter } = waitOf({ onEvent, task: undefined });
    const artifact = {
      artifactId: "a",
      name: "",
      description: "",
      parts: [],
      metadata: undefined,
      extensions: [],
    };

    expect(waiter.took(WORKING)).toBeUndefined();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith({ payload: { $case: "task", value: WORKING } });
    waiter.took(WORKING);
    expect(onEvent).toHaveBeenCalledTimes(1);
    waiter.took({ ...WORKING, artifacts: [artifact] });
    expect(onEvent).toHaveBeenCalledTimes(2);
    waiter.took({ ...WORKING, artifacts: [artifact] });
    expect(onEvent).toHaveBeenCalledTimes(2);
    waiter.took(taskOf(TaskState.TASK_STATE_INPUT_REQUIRED, { artifacts: [artifact] }));
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it("a polled settled task is returned, a polled task of another id is malformed", () => {
    const { waiter } = waitOf();

    expect(waiter.took(taskOf(TaskState.TASK_STATE_FAILED))?.status?.state).toBe(
      TaskState.TASK_STATE_FAILED,
    );
    expect(() => waiter.took(taskOf(TaskState.TASK_STATE_COMPLETED, { id: "other" }))).toThrow(
      A2AError.Remote,
    );
  });

  it("with no onEvent nothing is reported and nothing fails", () => {
    const { waiter } = waitOf({ task: undefined });

    expect(waiter.took(WORKING)).toBeUndefined();
    expect(waiter.take({ payload: { $case: "task", value: WORKING } })).toBeUndefined();
  });
});

describe("#1366: the wait leaves no listener behind", () => {
  it("the caller's signal is listened to once — the listener goes with the abort it answers, and with the wait's close", async () => {
    const caller = new AbortController();
    const { waiter } = waitOf({ signal: caller.signal });
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(1);
    caller.abort(new Error("the caller left"));
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(waiter.signal.aborted).toBe(true);

    const other = new AbortController();
    const closing = waitOf({ signal: other.signal });
    expect(getEventListeners(other.signal, "abort")).toHaveLength(1);
    closing.waiter.close();
    expect(getEventListeners(other.signal, "abort")).toHaveLength(0);
  });

  it("the promise that rejects with the wait's reason is listened to once, and its rejection is never unhandled", async () => {
    const { waiter } = waitOf();
    const rejected = waiter.abortedPromise();
    expect(getEventListeners(waiter.signal, "abort")).toHaveLength(1);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);

    waiter.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", listener);

    expect(getEventListeners(waiter.signal, "abort")).toHaveLength(0);
    expect(unhandled).toEqual([]);
    await expect(rejected).rejects.toThrow("the wait ended");
  });

  it("a deadline error of a task never seen and a cancel that left no answer has no context, and is still the deadline's", async () => {
    for (const outcome of [
      () => Promise.reject(new Error("refused")),
      () => new Promise<Task>(() => undefined),
    ]) {
      const { waiter, cancelTask, sleeps } = waitOf({ deadlineAt: new Date(0), task: undefined });
      cancelTask.mockImplementation(outcome);
      waiter.armDeadline();
      await turn();
      const pending = waiter.aborted().catch((thrown: unknown) => thrown);
      await turn();
      sleeps.find((one) => one.delay === CANCEL_TIMEOUT)?.end();

      expect(await pending).toMatchObject({ contextId: "" });
    }
  });
});
