/**
 * #941 AC7 (I16): an A2A task waiting for its caller's input expires — its subscribers see it
 * `WORKING` (the expiry pass announces `onExecutionResume(Expired)` once, with a decision or
 * without), then `FAILED` with `step.pause-expired` (or `COMPLETED` with the default the channel
 * decided); a follow-up after the deadline is `-32004`, `a2a.pause-closed`, reason `expired`.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { ResumeReason } from "../../src/core/observability.js";
import { A2ATaskRepository } from "../../src/infrastructure/a2a-task.repository.js";
import { testWith } from "../../src/testing/index.js";
import { minutes } from "../../src/units/index.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import { expiry, expiryStore, resetExpiry } from "../flow/fixtures/expiry.fixture.js";
import { BearerCallerResolver } from "./fixtures/bearer-caller-resolver.js";
import { ExpiryServedApplication, OwnerA2AExpose } from "./fixtures/expiry-served.application.js";
import { data, errorInfoOf, errorOf, rpc, userMessage, type RpcAnswer } from "./server/rpc.js";

const test = testWith(ExpiryServedApplication);
const listener = { expose: OwnerA2AExpose, callerResolver: BearerCallerResolver };

beforeEach(resetExpiry);

interface WireTask {
  readonly id: string;
  readonly status: {
    readonly state: string;
    readonly message?: { parts: Record<string, unknown>[] };
  };
}

const taskOf = (answer: RpcAnswer): WireTask => {
  const result = answer.body.result as { task?: WireTask } | WireTask | undefined;
  if (result === undefined) throw new Error(`no result: ${JSON.stringify(answer.body)}`);
  return "task" in result && result.task !== undefined ? result.task : (result as WireTask);
};

const order = (messageId: string) => userMessage(messageId, [data({ orderId: "o-1" })], {});

/** The states the task's projection wrote, in order. */
const statesWritten = (spy: { mock: { calls: readonly unknown[][] } }): string[] =>
  spy.mock.calls.map(([, , status]) => (status as { state: string }).state);

describe("#941 AC7: an A2A task whose pause expires", () => {
  test("AC7: INPUT_REQUIRED, then WORKING (one Expired resume), then FAILED step.pause-expired", async ({
    a2aServer,
    app,
    clock,
  }) => {
    const { url } = await a2aServer(listener);
    const paused = taskOf(await rpc(url, "SendMessage", { message: order("m-1") }));
    expect(paused.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    const writes = vi.spyOn(app.resolve(A2ATaskRepository), "compareAndSetStatus");

    await clock.advance(minutes(10));
    await until(() => expiry.errors.length === 1);
    await until(() => statesWritten(writes).includes("TASK_STATE_FAILED"));

    expect(statesWritten(writes)).toEqual(["TASK_STATE_WORKING", "TASK_STATE_FAILED"]);
    expect(expiry.resumes.filter((one) => one.reason === ResumeReason.Expired)).toHaveLength(1);
    const task = taskOf(await rpc(url, "GetTask", { id: paused.id }));
    expect(task.status.state).toBe("TASK_STATE_FAILED");
    expect(JSON.stringify(task.status.message)).toContain("step.pause-expired");
  });

  test("AC7: decide → COMPLETED with the default", async ({ a2aServer, app, clock }) => {
    expiry.ownerBehavior = () => PauseExpiration.decide({ approved: true, comment: "auto" });
    const { url } = await a2aServer(listener);
    const paused = taskOf(await rpc(url, "SendMessage", { message: order("m-1") }));
    const writes = vi.spyOn(app.resolve(A2ATaskRepository), "compareAndSetStatus");

    await clock.advance(minutes(10));
    await until(() => statesWritten(writes).includes("TASK_STATE_COMPLETED"));

    expect(statesWritten(writes)).toEqual(["TASK_STATE_WORKING", "TASK_STATE_COMPLETED"]);
    expect(expiry.recorded).toEqual(["o-1: approved (auto)"]);
    expect(taskOf(await rpc(url, "GetTask", { id: paused.id })).status.state).toBe(
      "TASK_STATE_COMPLETED",
    );
  });

  test("AC7: a follow-up after the deadline, before the look: -32004 a2a.pause-closed, reason expired — the task is still INPUT_REQUIRED", async ({
    a2aServer,
    clock,
  }) => {
    const { url } = await a2aServer(listener);
    const paused = taskOf(await rpc(url, "SendMessage", { message: order("m-1") }));
    vi.spyOn(expiryStore(), "findPendingByExpiresAtBefore").mockResolvedValue([]);
    await clock.advance(minutes(10));

    const late = await rpc(url, "SendMessage", {
      message: userMessage("m-2", [data({ decision: { approved: true } })], { taskId: paused.id }),
    });

    expect(errorOf(late).code).toBe(-32004);
    expect(errorInfoOf(late)).toMatchObject({ code: "a2a.pause-closed", reason: "expired" });
    expect(expiry.errors).toHaveLength(0);
  });

  test("AC7: a follow-up once the look expired it: the task is over (a2a.task-over)", async ({
    a2aServer,
    clock,
  }) => {
    const { url } = await a2aServer(listener);
    const paused = taskOf(await rpc(url, "SendMessage", { message: order("m-1") }));
    await clock.advance(minutes(10));
    await until(() => expiry.errors.length === 1);

    const late = await rpc(url, "SendMessage", {
      message: userMessage("m-2", [data({ decision: { approved: true } })], { taskId: paused.id }),
    });

    expect(errorOf(late).code).toBe(-32004);
    expect(errorInfoOf(late)).toMatchObject({ code: "a2a.task-over" });
  });
});
