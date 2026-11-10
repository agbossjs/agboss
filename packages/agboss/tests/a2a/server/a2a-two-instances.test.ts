/**
 * #811 AC3 (epic #805 AC3): an A2A server on two instances. A message resent after its answer was
 * lost lands on the other instance and gets the same task, one execution; a task whose instance died
 * mid-run is recovered on the other, whose projection moves it to its end — and, its end event lost
 * there too, whose read repair does — never overwritten by the dead instance when it comes back.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { a2aHttpListener } from "../../../src/a2a/index.js";
import {
  A2ATaskRepository,
  A2ATaskState,
  type A2ATaskStatus,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import type { TestApp, TestLeases } from "../../../src/testing/index.js";
import type { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";
import { until } from "../../helpers/until.js";
import { instance, settle } from "../../app/fixtures/fence-takeover.js";
import {
  Clerk,
  Hold,
  levers,
  ReceiptDto,
  resetRecovery,
  seen,
  Step,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { OrdersA2AExpose, OrdersApplication } from "../fixtures/task.application.js";
import { eventually, rpc, text, userMessage, type RpcAnswer } from "./rpc.js";

const two = testWith(OrdersApplication, { instances: 2, allowNetwork: ["127.0.0.1"] });
const listener = { expose: OrdersA2AExpose, callerResolver: BearerCallerResolver };
const done = replyWith(ReceiptDto, { text: "Done." });
const goNow = (messageId: string) => ({
  message: userMessage(messageId, [text("go")]),
  configuration: { returnImmediately: true },
});

const servers: Server[] = [];

beforeEach(resetRecovery);
afterEach(async () => {
  levers.letGo?.();
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

/** A listener of `app` on its own loopback port. */
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
  readonly status: { readonly state: string };
}

const taskOf = (answer: RpcAnswer): WireTask => {
  const result = answer.body.result as { task?: WireTask } | WireTask | undefined;
  if (result === undefined) throw new Error(`no result: ${JSON.stringify(answer.body)}`);
  return "task" in result && result.task !== undefined ? result.task : (result as WireTask);
};

const stateOf = async (url: string, id: string): Promise<string> =>
  taskOf(await rpc(url, "GetTask", { id })).status.state;

/** A's lease frozen and the clock past it twice: B's recovery sweep takes the tree over. */
async function recoveredOnB(clock: VirtualClock, leases: TestLeases, a: TestApp): Promise<void> {
  leases.freeze(a);
  await clock.advance(seconds(31));
  await clock.advance(seconds(31));
  await settle();
}

/** Loses every write of a `COMPLETED` status by `app`'s instance (its end event lost). */
const losingEnds = (app: TestApp) => {
  const tasks = app.resolve(A2ATaskRepository);
  const write = tasks.compareAndSetStatus.bind(tasks);
  return vi
    .spyOn(tasks, "compareAndSetStatus")
    .mockImplementation((key, version, status: A2ATaskStatus, at) =>
      status.state === A2ATaskState.Completed
        ? Promise.resolve(undefined)
        : write(key, version, status, at),
    );
};

describe("#811 AC3: two server instances", () => {
  two(
    "a resend after a lost answer lands on the other instance: the same task, one execution",
    async ({ apps, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Step, { text: "once" }), done);
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      const [aUrl, bUrl] = [await serverOf(a), await serverOf(b)];

      const accepted = taskOf(await rpc(aUrl, "SendMessage", goNow("m-1"))); // its answer "lost"
      const resent = taskOf(await rpc(bUrl, "SendMessage", goNow("m-1")));
      await eventually(
        async () => (await stateOf(bUrl, accepted.id)) === "TASK_STATE_COMPLETED",
        "completed",
      );

      expect(resent.id).toBe(accepted.id);
      expect(seen.steps).toEqual(["once"]);
      expect(await stateOf(aUrl, accepted.id)).toBe("TASK_STATE_COMPLETED");
    },
  );

  two(
    "A dies mid-run: B recovers the task's execution and B's projection completes the task",
    async ({ apps, clock, leases, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Hold, { text: "wait" }), done);
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      const [aUrl, bUrl] = [await serverOf(a), await serverOf(b)];
      const sent = taskOf(await rpc(aUrl, "SendMessage", goNow("m-1")));
      await until(() => seen.holds.length === 1, "A holds");

      await recoveredOnB(clock, leases, a);
      await eventually(
        async () => (await stateOf(bUrl, sent.id)) === "TASK_STATE_COMPLETED",
        "B completed it",
      );
      // A comes back: its late pass cannot move the task off its end
      leases.thaw(a);
      levers.letGo?.();
      await settle();

      expect(seen.holds.length).toBeGreaterThanOrEqual(2); // B ran the step again
      expect(await stateOf(aUrl, sent.id)).toBe("TASK_STATE_COMPLETED");
      expect(await stateOf(bUrl, sent.id)).toBe("TASK_STATE_COMPLETED");
    },
    30_000,
  );

  two(
    "A dies mid-run and B's end event is lost: B's read repair completes the task from the records",
    async ({ apps, clock, leases, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Hold, { text: "wait" }), done);
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      const [aUrl, bUrl] = [await serverOf(a), await serverOf(b)];
      const sent = taskOf(await rpc(aUrl, "SendMessage", goNow("m-1")));
      await until(() => seen.holds.length === 1, "A holds");
      const lost = losingEnds(b);

      await recoveredOnB(clock, leases, a);
      await until(() => seen.ends.length >= 1, "B's execution ended");
      await settle();
      const unrepaired = await b.resolve(A2ATaskRepository).findById({
        tenantId: "default",
        taskId: sent.id,
      });
      const lostStates = lost.mock.calls.map(([, , status]) => status.state);
      lost.mockRestore();
      await clock.advance(seconds(31));

      expect(lostStates).toContain(A2ATaskState.Completed);
      expect(unrepaired?.status.state).not.toBe(A2ATaskState.Completed);
      expect(await stateOf(bUrl, sent.id)).toBe("TASK_STATE_COMPLETED");
      leases.thaw(a);
      levers.letGo?.();
      await settle();
      expect(await stateOf(aUrl, sent.id)).toBe("TASK_STATE_COMPLETED");
    },
    30_000,
  );
});
