/**
 * #808 AC3 (#806 AC1–AC3, design §4.3): the payment-grade guarantees of the server, each forced
 * deterministically — a duplicate `messageId` (one instance, two instances) starts one execution and
 * gets the same task; a caller that disconnects mid-stream or mid-wait never cancels its task; a
 * cancel and a resume racing never both take effect; a cancel before the start keeps any execution
 * from ever starting; a crash between the accept and the start leaves no stuck task — the resend
 * starts it under the same reserved id; a subscriber after a missed update gets the task as its
 * records say; a task read after more than 20 later turns of its context is found (#808's
 * `findByTenantIdAndRunId`).
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { a2aHttpListener } from "../../../src/a2a/index.js";
import { requestHashOf } from "../../../src/a2a/server/a2a-message-input.js";
import { executionControlOf } from "../../../src/app/execution-control.js";
import {
  A2ATaskRepository,
  A2ATaskSaveStatus,
  A2ATaskState,
  type A2ATaskStatus,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { until } from "../../helpers/until.js";
import {
  Charge,
  Clerk,
  Hold,
  levers,
  OrderWorkflowStart,
  ReceiptDto,
  resetRecovery,
  seen,
  Step,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { OrdersA2AExpose, OrdersApplication } from "../fixtures/task.application.js";
import { textMessage } from "./sdk-client.js";
import {
  data,
  errorOf,
  eventually,
  rpc,
  sseEvents,
  text,
  userMessage,
  type RpcAnswer,
} from "./rpc.js";

const one = testWith(OrdersApplication);
const two = testWith(OrdersApplication, { instances: 2 });
const listener = { expose: OrdersA2AExpose, callerResolver: BearerCallerResolver };
const done = replyWith(ReceiptDto, { text: "Done." });
const go = (messageId: string, value = "go") => ({
  message: userMessage(messageId, [text(value)]),
});
const goNow = (messageId: string) => ({
  ...go(messageId),
  configuration: { returnImmediately: true },
});

const servers: Server[] = [];

beforeEach(resetRecovery);
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** A listener of `app` on its own loopback port (the test's a2aServer opened the loopback). */
async function serverOf(app: TestApp): Promise<string> {
  await app.ready();
  const bound: { handle?: ReturnType<typeof a2aHttpListener> } = {};
  const server = createServer((req, res) => bound.handle?.(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${String(typeof address === "object" && address !== null ? address.port : 0)}`;
  bound.handle = a2aHttpListener(app, { ...listener, publicUrl: url });
  return url;
}

interface WireTask {
  readonly id: string;
  readonly contextId: string;
  readonly status: { readonly state: string; readonly message?: unknown };
}

const taskOf = (answer: RpcAnswer): WireTask => {
  const result = answer.body.result as { task?: WireTask } | WireTask | undefined;
  if (result === undefined) throw new Error(`no result: ${JSON.stringify(answer.body)}`);
  return "task" in result && result.task !== undefined ? result.task : (result as WireTask);
};

const stateOf = async (url: string, id: string) =>
  taskOf(await rpc(url, "GetTask", { id })).status.state;

/** The task, accepted as a server accepts it, and nothing started: a crash right after the accept. */
async function acceptedOnly(app: TestApp, messageId: string, taskId: string) {
  await app.ready();
  const message = textMessage(messageId, "go");
  const save = await app.resolve(A2ATaskRepository).saveIfAbsent({
    tenantId: "default",
    taskId,
    ownerId: "dana",
    contextId: "ctx-crash",
    skill: "order-workflow-start",
    status: { state: A2ATaskState.Submitted, pendingPauses: [] },
    acceptedAt: app.clock.now(),
    messageId,
    requestHash: requestHashOf("order-workflow-start", message),
  });
  if (save.status !== A2ATaskSaveStatus.Saved) throw new Error(save.status);
}

describe("#808 AC3: one execution per messageId", () => {
  one(
    "the same messageId twice at once on one instance: one task, one execution",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Step, { text: "once" }), done);
      const { url } = await a2aServer(listener);

      const [first, second] = await Promise.all([
        rpc(url, "SendMessage", go("m-1")),
        rpc(url, "SendMessage", go("m-1")),
      ]);

      expect(taskOf(first).id).toBe(taskOf(second).id);
      expect(taskOf(first).status.state).toBe("TASK_STATE_COMPLETED");
      expect(taskOf(second).status.state).toBe("TASK_STATE_COMPLETED");
      expect(seen.steps).toEqual(["once"]);
    },
  );

  two(
    "the same messageId on two instances at once: one task, one execution",
    async ({ apps, a2aServer, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Step, { text: "once" }), done);
      const [, second] = apps;
      if (second === undefined) throw new Error("two instances");
      const { url: firstUrl } = await a2aServer(listener);
      const secondUrl = await serverOf(second);

      const answers = await Promise.all([
        rpc(firstUrl, "SendMessage", goNow("m-1")),
        rpc(secondUrl, "SendMessage", goNow("m-1")),
      ]);
      const [id] = answers.map((answer) => taskOf(answer).id);
      await eventually(
        async () => (await stateOf(firstUrl, id ?? "")) === "TASK_STATE_COMPLETED",
        "completed",
      );

      expect(answers.map((answer) => taskOf(answer).id)).toEqual([id, id]);
      expect(seen.steps).toEqual(["once"]);
      expect(await stateOf(secondUrl, id ?? "")).toBe("TASK_STATE_COMPLETED");
    },
  );

  one(
    "a messageId again with other content is -32602, and starts nothing",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(Clerk).thenReturn(done);
      const { url } = await a2aServer(listener);
      await rpc(url, "SendMessage", go("m-1"));

      const reused = await rpc(url, "SendMessage", go("m-1", "something else"));

      expect(errorOf(reused).code).toBe(-32602);
      expect(mockLlm(Clerk)).toHaveBeenCalledTimes(1);
    },
  );

  one(
    "an authenticated caller without mesh signing is deduplicated too (#806 AC3); another caller's id is another message",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(Clerk).thenReturn(done, done);
      const { url } = await a2aServer(listener);

      const dana = taskOf(await rpc(url, "SendMessage", go("m-1")));
      const again = taskOf(await rpc(url, "SendMessage", go("m-1")));
      const eve = taskOf(await rpc(url, "SendMessage", go("m-1"), { owner: "eve" }));

      expect(again.id).toBe(dana.id);
      expect(eve.id).not.toBe(dana.id);
      expect(mockLlm(Clerk)).toHaveBeenCalledTimes(2);
    },
  );
});

describe("#808 AC3 (#806 AC1): a disconnect never cancels the task", () => {
  one(
    "a stream dropped mid-run: the task runs on to COMPLETED; a resend gets it, never a cancel",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Hold, { text: "wait" }), done);
      const { url } = await a2aServer(listener);

      const streamed = await sseEvents(url, "SendStreamingMessage", go("m-1"), { count: 1 });
      const id = (streamed.events[0]?.result as { task: WireTask }).task.id;
      await until(() => seen.holds.length === 1, "the hold started");
      // the caller is gone: let the hold go
      levers.letGo?.();
      await eventually(
        async () => (await stateOf(url, id)) === "TASK_STATE_COMPLETED",
        "completed",
      );
      const resent = taskOf(await rpc(url, "SendMessage", go("m-1")));

      expect(seen.holds[0]?.aborted).toBe(false);
      expect(resent).toMatchObject({ id, status: { state: "TASK_STATE_COMPLETED" } });
    },
  );

  one(
    "a blocking SendMessage whose caller hangs up: the task runs on",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Hold, { text: "wait" }), done);
      const { url } = await a2aServer(listener);
      const hangUp = new AbortController();

      const pending = rpc(url, "SendMessage", go("m-1"), { signal: hangUp.signal }).catch(
        (error: unknown) => error,
      );
      await until(() => seen.holds.length === 1, "the hold started");
      hangUp.abort();
      await pending;
      levers.letGo?.();
      const resent = await rpc(url, "SendMessage", go("m-1"));

      expect(seen.holds[0]?.aborted).toBe(false);
      expect(taskOf(resent).status.state).toBe("TASK_STATE_COMPLETED");
    },
  );
});

describe("#808 AC3: cancel and resume, cancel before start", () => {
  /** A task paused at its charge's approval. */
  const paused = async (url: string) => {
    const task = taskOf(await rpc(url, "SendMessage", go("m-1")));
    if (task.status.state !== "TASK_STATE_INPUT_REQUIRED") throw new Error(task.status.state);
    return task;
  };
  const approve = (taskId: string) => ({
    message: userMessage("m-2", [data({ decision: { approved: true } })], { taskId }),
  });

  one(
    "cancel first: the resume is -32004, nothing charged, the task CANCELED",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
      const { url } = await a2aServer(listener);
      const task = await paused(url);

      const canceled = taskOf(await rpc(url, "CancelTask", { id: task.id }));
      const resume = await rpc(url, "SendMessage", approve(task.id));

      expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
      expect(errorOf(resume).code).toBe(-32004);
      expect(seen.charges).toEqual([]);
    },
  );

  one(
    "a cancel landing between the answer's check and its resume: the resume loses (-32004), nothing charged",
    async ({ a2aServer, app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
      const { url } = await a2aServer(listener);
      const task = await paused(url);
      const resume = app.resume.bind(app);
      vi.spyOn(app, "resume").mockImplementation(async (request, options) => {
        // the cancel's withdrawal wins the pause's atomic transition
        await rpc(url, "CancelTask", { id: task.id });
        return resume(request, options);
      });

      const answer = await rpc(url, "SendMessage", approve(task.id));

      expect(errorOf(answer)).toMatchObject({ code: -32004 });
      expect(await stateOf(url, task.id)).toBe("TASK_STATE_CANCELED");
      expect(seen.charges).toEqual([]);
    },
  );

  one(
    "resume first: charged once, COMPLETED; the cancel after is -32002",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }), done);
      const { url } = await a2aServer(listener);
      const task = await paused(url);

      const resumed = taskOf(await rpc(url, "SendMessage", approve(task.id)));
      const cancel = await rpc(url, "CancelTask", { id: task.id });

      expect(resumed.status.state).toBe("TASK_STATE_COMPLETED");
      expect(errorOf(cancel).code).toBe(-32002);
      expect(seen.charges).toEqual(["10 USD"]);
    },
  );

  one(
    "both at once: never both — a canceled task charged nothing, a charged one was not canceled",
    async ({ a2aServer, app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }), done);
      const { url } = await a2aServer(listener);
      const task = await paused(url);

      const [cancel, resume] = await Promise.all([
        rpc(url, "CancelTask", { id: task.id }),
        rpc(url, "SendMessage", approve(task.id)),
      ]);
      await eventually(async () => {
        const state = await stateOf(url, task.id);
        return state === "TASK_STATE_CANCELED" || state === "TASK_STATE_COMPLETED";
      }, "over");
      const final = await stateOf(url, task.id);

      if (final === "TASK_STATE_CANCELED") {
        expect(seen.charges).toEqual([]);
        expect(cancel.body.result).toBeDefined();
        expect(errorOf(resume).code).toBe(-32004);
        // the charge's second turn never ran: another execution takes it
        await execute(app, OrderWorkflowStart, { text: "go" });
      } else {
        expect(seen.charges).toEqual(["10 USD"]);
        expect(errorOf(cancel).code).toBe(-32002);
        expect(taskOf(resume).status.state).toBe("TASK_STATE_COMPLETED");
      }
    },
  );

  one(
    "cancel before the start: CANCELED at once, and no execution ever starts under the task's id",
    async ({ a2aServer, app, mockLlm }) => {
      const { url } = await a2aServer(listener);
      await acceptedOnly(app, "m-1", "task-unstarted");

      const canceled = taskOf(await rpc(url, "CancelTask", { id: "task-unstarted" }));
      const resent = taskOf(await rpc(url, "SendMessage", goNow("m-1")));

      expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
      expect(resent).toMatchObject({
        id: "task-unstarted",
        status: { state: "TASK_STATE_CANCELED" },
      });
      expect(mockLlm(Clerk)).toHaveBeenCalledTimes(0);
      const control = executionControlOf(app);
      expect(
        await control?.claimExecutionId({ executionId: "task-unstarted", tenantId: "default" }),
      ).toBe(false);
    },
  );

  one(
    "a cancel targets that task only: another task of its context runs on",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Hold, { text: "wait" }), done);
      const { url } = await a2aServer(listener);
      const inContext = (messageId: string) => ({
        message: userMessage(messageId, [text("go")], { contextId: "ctx-shared" }),
        configuration: { returnImmediately: true },
      });
      const held = taskOf(await rpc(url, "SendMessage", inContext("m-1")));
      await until(() => seen.holds.length === 1, "the hold started");
      const other = taskOf(await rpc(url, "SendMessage", inContext("m-2")));
      await eventually(
        async () => (await stateOf(url, other.id)) === "TASK_STATE_COMPLETED",
        "the other completed",
      );

      const canceled = taskOf(await rpc(url, "CancelTask", { id: held.id }));

      expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
      expect(await stateOf(url, other.id)).toBe("TASK_STATE_COMPLETED");
    },
  );
});

describe("#808 AC3 (#806 AC2): a crash between the accept and the start", () => {
  one(
    "the resend starts the accepted task under its own id, once",
    async ({ a2aServer, app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Step, { text: "once" }), done);
      const { url } = await a2aServer(listener);
      await acceptedOnly(app, "m-1", "task-crashed");

      const resent = taskOf(await rpc(url, "SendMessage", go("m-1")));
      const again = taskOf(await rpc(url, "SendMessage", go("m-1")));

      expect(resent).toMatchObject({
        id: "task-crashed",
        contextId: "ctx-crash",
        status: { state: "TASK_STATE_COMPLETED" },
      });
      expect(again.status.state).toBe("TASK_STATE_COMPLETED");
      expect(seen.steps).toEqual(["once"]);
    },
  );
});

describe("#808: reads repair what an update missed", () => {
  /** Loses every write of a status in `states` (the projection's events are at most once). */
  const losing = (app: TestApp, states: readonly A2ATaskState[]) => {
    const tasks = app.resolve(A2ATaskRepository);
    const write = tasks.compareAndSetStatus.bind(tasks);
    return vi
      .spyOn(tasks, "compareAndSetStatus")
      .mockImplementation((key, version, status: A2ATaskStatus, at) =>
        states.includes(status.state)
          ? Promise.resolve(undefined)
          : write(key, version, status, at),
      );
  };

  one(
    "SubscribeToTask after a missed update: its first event is the task as its records say",
    async ({ a2aServer, app, clock, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }), done);
      const { url } = await a2aServer(listener);
      await app.ready();
      const lost = losing(app, [A2ATaskState.InputRequired]);
      const task = taskOf(await rpc(url, "SendMessage", goNow("m-1")));
      await until(
        () => lost.mock.calls.some(([, , status]) => status.state === A2ATaskState.InputRequired),
        "the pause's write lost",
      );
      lost.mockRestore();
      await clock.advance(seconds(31));

      const subscribed = sseEvents(url, "SubscribeToTask", { id: task.id });
      await eventually(
        async () => (await stateOf(url, task.id)) === "TASK_STATE_INPUT_REQUIRED",
        "repaired",
      );
      await rpc(url, "SendMessage", {
        message: userMessage("m-2", [data({ decision: { approved: true } })], { taskId: task.id }),
      });
      const { events } = await subscribed;

      expect(events[0]).toMatchObject({
        result: { task: { id: task.id, status: { state: "TASK_STATE_INPUT_REQUIRED" } } },
      });
      expect(events.at(-1)).toMatchObject({
        result: { statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } } },
      });
      expect(seen.charges).toEqual(["10 USD"]);
    },
  );

  one(
    "GetTask of a task whose failure was missed, after 21 later turns of its context: FAILED",
    async ({ a2aServer, app, clock, mockLlm }) => {
      // the clerk's second call has no script: the execution fails
      mockLlm(Clerk).thenReturn(callTool(Step, { text: "one" }));
      const { url } = await a2aServer(listener);
      await app.ready();
      const lost = losing(app, [A2ATaskState.Failed]);
      const task = taskOf(
        await rpc(url, "SendMessage", {
          message: userMessage("m-1", [text("go")], { contextId: "ctx-long" }),
          configuration: { returnImmediately: true },
        }),
      );
      await until(() => seen.errors.length === 1, "the execution failed");
      lost.mockRestore();
      for (let turn = 0; turn < 21; turn += 1) {
        mockLlm(Clerk).thenReturn(done);
        await execute(
          app,
          OrderWorkflowStart,
          { text: `turn ${String(turn)}` },
          { threadId: "ctx-long", ownerId: "dana" },
        );
      }
      await clock.advance(seconds(31));

      const read = taskOf(await rpc(url, "GetTask", { id: task.id }));

      expect(read.status.state).toBe("TASK_STATE_FAILED");
    },
  );
});
