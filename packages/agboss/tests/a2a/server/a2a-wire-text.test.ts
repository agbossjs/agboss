/**
 * #808 (the #807 security rule on the wire): an error's own text — which may carry an e-mail, a
 * secret, a model's or a tool's words — reaches no `GetTask`, `ListTasks`, stream or JSON-RPC error;
 * a coded error gives its code and the code's fixed text, an uncoded one `internal`.
 * Also #808 AC2: `ListTasks` — the caller's tasks only, newest status first, paged, `nextPageToken`
 * always present and `""` on the last page, filtered by context and state.
 */
import { beforeEach, describe, expect } from "vitest";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../../../src/a2a/index.js";
import { AGBossError } from "../../../src/core/errors.js";
import { callTool, testWith } from "../../../src/testing/index.js";
import {
  DeskClerkAgent,
  hooks,
  RefundTool,
  resetPauses,
} from "../../channels/fixtures/pauses.workflow.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { DeskA2AExpose, ServedPausesApplication } from "../fixtures/served-pauses.application.js";
import { errorInfoOf, errorOf, rpc, sseEvents, text, userMessage } from "./rpc.js";

const test = testWith(ServedPausesApplication);
const listener = { expose: DeskA2AExpose, callerResolver: BearerCallerResolver };
const DESK = { [A2A_SKILLS_EXTENSION]: { skill: "desk-workflow-start" } };
const SECRET = "alice@example.com card 4242 4242 4242 4242 sk_live_abc123";

class PaymentDeclinedError extends AGBossError {
  static override readonly code: string = "payment.declined";
}

beforeEach(resetPauses);

const refund = (messageId: string, orderId: string, contextId?: string) => ({
  message: userMessage(messageId, [text(`refund ${orderId}`)], {
    metadata: DESK,
    ...(contextId === undefined ? {} : { contextId }),
  }),
});

describe("#808: no error text on the wire", () => {
  test("a failure's text reaches no answer, read, list or stream; its code does, with the fixed text", async ({
    a2aServer,
    mockLlm,
  }) => {
    hooks.refusals = new Map([
      ["7", new Error(SECRET)],
      ["8", new PaymentDeclinedError(SECRET)],
    ]);
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "8" }));
    const { url } = await a2aServer(listener);

    const plain = await rpc(url, "SendMessage", refund("m-1", "7"));
    const coded = await rpc(url, "SendMessage", refund("m-2", "8"));
    const plainTask = (plain.body.result as { task: { id: string } }).task;
    const codedTask = (coded.body.result as { task: { id: string } }).task;
    const reads = [
      plain,
      coded,
      await rpc(url, "GetTask", { id: plainTask.id }),
      await rpc(url, "GetTask", { id: codedTask.id }),
      await rpc(url, "ListTasks", {}),
      await rpc(url, "SubscribeToTask", { id: codedTask.id }),
    ];
    const streamed = await sseEvents(url, "SendStreamingMessage", refund("m-3", "7"));

    for (const read of reads) expect(JSON.stringify(read.body)).not.toMatch(/alice|4242|sk_live/);
    expect(JSON.stringify(streamed.events)).not.toMatch(/alice|4242|sk_live/);
    const statusOf = (answer: typeof plain) =>
      (answer.body.result as { task: { status: { message: unknown } } }).task.status;
    expect(statusOf(plain)).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: { parts: [{ text: "the task failed: step.agent" }] },
    });
    // the channel's error failed its agent's step: the step's code, never the error's own text
    expect(statusOf(coded)).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: {
        parts: [{ text: "the task failed: step.agent" }],
        metadata: { [A2A_MESH_EXTENSION]: { code: "step.agent" } },
      },
    });
  });

  test("an unexpected failure in a handler is -32603 with a fixed text", async ({
    a2aServer,
    app,
  }) => {
    const { url } = await a2aServer(listener);
    const { A2ATaskRepository } =
      await import("../../../src/infrastructure/a2a-task.repository.js");
    const tasks = app.resolve(A2ATaskRepository);
    tasks.findById = () => Promise.reject(new Error(SECRET));

    const answer = await rpc(url, "GetTask", { id: "task-1" });

    expect(errorOf(answer)).toEqual({ code: -32603, message: "the request failed" });
    expect(errorInfoOf(answer)).toBeUndefined();
  });
});

describe("#808 AC2: ListTasks", () => {
  test("the caller's tasks, newest first, paged; filtered by context and state; a bad token -32602", async ({
    a2aServer,
    mockLlm,
    clock,
  }) => {
    const { seconds } = await import("../../../src/units/index.js");
    hooks.refusals = new Map([["9", new Error("refused")]]);
    for (const orderId of ["1", "2", "3"])
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId }));
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "9" }));
    const { url } = await a2aServer(listener);
    const ids: string[] = [];
    for (const [index, orderId] of ["1", "2", "3", "9"].entries()) {
      const contextId = index < 2 ? "ctx-a" : "ctx-b";
      const sent = await rpc(url, "SendMessage", {
        ...refund(`m-${orderId}`, orderId, contextId),
        configuration: { returnImmediately: index < 3 },
      });
      ids.push((sent.body.result as { task: { id: string } }).task.id);
      await clock.advance(seconds(1));
    }
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "5" }));
    await rpc(
      url,
      "SendMessage",
      { ...refund("m-eve", "5"), configuration: { returnImmediately: true } },
      { owner: "eve" },
    );

    const listed = async (params: Record<string, unknown>) =>
      (await rpc(url, "ListTasks", params)).body.result as {
        tasks: { id: string }[];
        nextPageToken: string;
        pageSize: number;
        totalSize?: number;
      };
    const first = await listed({ pageSize: 2 });
    const second = await listed({ pageSize: 2, pageToken: first.nextPageToken });
    const inA = await listed({ contextId: "ctx-a" });
    const failed = await listed({ status: "TASK_STATE_FAILED" });
    const bad = await rpc(url, "ListTasks", { pageToken: "not-a-token" });
    const tooBig = await rpc(url, "ListTasks", { pageSize: 101 });

    expect([...first.tasks, ...second.tasks].map((task) => task.id)).toEqual([...ids].reverse());
    expect(first.nextPageToken).not.toBe("");
    expect(second.nextPageToken).toBe("");
    expect(inA.tasks.map((task) => task.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(failed.tasks.map((task) => task.id)).toEqual([ids[3]]);
    expect(errorInfoOf(bad)?.code).toBe("a2a.invalid-page-token");
    expect(errorInfoOf(tooBig)?.code).toBe("a2a.page-size");
    const badTime = await rpc(url, "ListTasks", { statusTimestampAfter: "yesterday" });
    expect(errorInfoOf(badTime)?.code).toBe("a2a.invalid-timestamp");
    // #824: totalSize counts every task the filters match, before paging; pageSize is the one used
    expect([first.totalSize, second.totalSize, inA.totalSize, failed.totalSize]).toEqual([
      4, 4, 2, 1,
    ]);
    expect([first.pageSize, second.pageSize, inA.pageSize]).toEqual([2, 2, 50]);
    const since = await listed({ pageSize: 2, statusTimestampAfter: "2000-01-01T00:00:00Z" });
    expect([since.tasks.length, since.totalSize, since.nextPageToken === ""]).toEqual([
      2,
      4,
      false,
    ]);
    const sinceNext = await listed({
      pageSize: 2,
      statusTimestampAfter: "2000-01-01T00:00:00Z",
      pageToken: since.nextPageToken,
    });
    expect([...since.tasks, ...sinceNext.tasks].map((task) => task.id)).toEqual([...ids].reverse());
    // ProtoJSON leaves a zero count out
    const none = await listed({ statusTimestampAfter: "2999-01-01T00:00:00Z" });
    expect([none.tasks, none.nextPageToken, none.totalSize ?? 0]).toEqual([[], "", 0]);
  });
});
