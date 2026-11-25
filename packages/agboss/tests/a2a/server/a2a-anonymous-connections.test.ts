/**
 * #1320 / #1316 (conform, "anonymous access is opt-in and token-bound, never socket-bound"): an A2A
 * listener made with `allowAnonymous: true`, no `@HttpAuthenticator` and no `tenantContext`, through
 * the real HTTP handler. An anonymous caller owns nothing and is bound to nothing of its connection:
 * each new task has an owner of its own, the task's unpredictable id is the right to get, continue
 * and cancel it — over any connection —, another caller's resent `messageId` finds nothing of it,
 * and `ListTasks` is `403`. Two clients behind ONE pooled connection stay apart the same way.
 */
import { randomUUID } from "node:crypto";
import { Agent, request } from "node:http";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { replyWith, testWith } from "../../../src/testing/index.js";
import {
  Clerk,
  ReceiptDto,
  resetRecovery,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { OrdersA2AExpose, OrdersApplication } from "../fixtures/task.application.js";
import { rpcBody, text, userMessage } from "./rpc.js";

const test = testWith(OrdersApplication);
const done = replyWith(ReceiptDto, { text: "Done." });

/** One caller: its own keep-alive agent with one socket, so every call rides the same connection. */
class Connection {
  readonly #agent = new Agent({ keepAlive: true, maxSockets: 1 });

  constructor(private readonly url: string) {}

  /** The first JSON object an answer carries: its body, or its first server-sent event. */
  call(method: string, params: unknown): Promise<Record<string, unknown>> {
    const body = rpcBody(method, params);
    return new Promise((resolve, reject) => {
      const req = request(
        this.url,
        {
          method: "POST",
          agent: this.#agent,
          headers: {
            "content-type": "application/json",
            "a2a-version": "1.0",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let received = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            received += chunk;
          });
          res.on("end", () => {
            const line = received.startsWith("data:")
              ? (received.split("\n").find((each) => each.startsWith("data:")) ?? "").slice(5)
              : received;
            resolve(JSON.parse(line) as Record<string, unknown>);
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  close(): void {
    this.#agent.destroy();
  }
}

const NOT_FOUND = -32001;
const connections: Connection[] = [];
const connect = (url: string): Connection => {
  const made = new Connection(url);
  connections.push(made);
  return made;
};

beforeEach(() => {
  resetRecovery();
});

afterEach(() => {
  for (const each of connections.splice(0)) each.close();
});

describe("#1320: anonymous callers of one A2A listener", () => {
  const send = (messageId: string) => ({ message: userMessage(messageId, [text("go")]) });
  const taskIdOf = (answer: Record<string, unknown>): string =>
    (answer.result as { task: { id: string } }).task.id;

  test("two connections: a task is reached by its id, each caller's messageId is its own, listing is 403", async ({
    a2aServer,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(done).thenReturn(done);
    const { url } = await a2aServer({ endpoint: OrdersA2AExpose, allowAnonymous: true });
    const a = connect(url);
    const b = connect(url);

    const first = taskIdOf(await a.call("SendMessage", send("m-1")));
    // the same messageId from another caller is another message: its own task, nothing of A's
    const second = taskIdOf(await b.call("SendMessage", send("m-1")));

    expect(second).not.toBe(first);
    // the id is the capability, over whichever connection holds it
    for (const method of ["GetTask", "SubscribeToTask"]) {
      const answer = await b.call(method, { id: first });
      expect((answer.error as { code: number } | undefined)?.code, method).not.toBe(NOT_FOUND);
    }
    // an id that was never given out is found by no caller
    for (const method of ["GetTask", "CancelTask", "SubscribeToTask"]) {
      const answer = await b.call(method, { id: randomUUID() });
      expect((answer.error as { code: number }).code, method).toBe(NOT_FOUND);
    }
    // nothing lists: no caller can enumerate another's tasks
    for (const caller of [a, b]) {
      const listed = await caller.call("ListTasks", {});
      expect(listed.code).toBe("a2a.list-forbidden");
    }
  });

  test("two clients behind one pooled connection stay apart: two tasks, no listing", async ({
    a2aServer,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(done).thenReturn(done);
    const { url } = await a2aServer({ endpoint: OrdersA2AExpose, allowAnonymous: true });
    const pooled = connect(url);

    const first = taskIdOf(await pooled.call("SendMessage", send("m-1")));
    const second = taskIdOf(await pooled.call("SendMessage", send("m-1")));

    expect(second).not.toBe(first);
    const listed = await pooled.call("ListTasks", {});
    expect(listed.code).toBe("a2a.list-forbidden");
  });

  test("a listener with no authenticator and no allowAnonymous is not made", async ({
    a2aServer,
  }) => {
    await expect(a2aServer({ endpoint: OrdersA2AExpose })).rejects.toThrow(
      "[http.authenticator-required-for-tenant-context]",
    );
  });
});
