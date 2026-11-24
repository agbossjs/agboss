/**
 * #1320 (conform): an A2A listener with no `@HttpAuthenticator` and no `tenantContext` serves
 * anonymous callers, each bound to its own connection — through the real HTTP handler, not a unit of
 * its gate. Caller A's task is not found for caller B on get, cancel, subscribe and list; A still
 * reads it.
 */
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

describe("#1320: two anonymous connections of one A2A listener", () => {
  test("B finds nothing of A's task: get, cancel, subscribe, list; A reads it", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(done);
    const { url } = await a2aServer({ endpoint: OrdersA2AExpose });
    const a = connect(url);
    const b = connect(url);

    const sent = await a.call("SendMessage", { message: userMessage("m-1", [text("go")]) });
    const taskId = (sent.result as { task: { id: string } }).task.id;

    const own = await a.call("GetTask", { id: taskId });
    expect((own.result as { id: string }).id).toBe(taskId);
    for (const method of ["GetTask", "CancelTask", "SubscribeToTask"]) {
      const answer = await b.call(method, { id: taskId });
      expect(answer.result, method).toBeUndefined();
      expect((answer.error as { code: number }).code, method).toBe(NOT_FOUND);
    }
    const theirs = await b.call("ListTasks", {});
    const mine = await a.call("ListTasks", {});
    expect((theirs.result as { tasks?: unknown[] }).tasks ?? []).toEqual([]);
    expect((mine.result as { tasks: { id: string }[] }).tasks.map(({ id }) => id)).toEqual([
      taskId,
    ]);
    // the refusal gave B nothing of A's task
    expect(JSON.stringify(theirs)).not.toContain(taskId);
  });
});
