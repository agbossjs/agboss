/**
 * #809 — what the independent review of the client found, each pinned (the `a2a-client` mutation
 * shard): which codes certainly did nothing, a request that never left, the wait's own failures
 * never read as a dropped stream, every event of the waited task only, one rule for transient
 * reads, the HTTP+JSON binding's errors, a fetcher that follows redirects itself, how the cancel at
 * a deadline went, the price charged at the accept, the mesh refused when it cannot ride, remote
 * strings kept out of errors.
 */
import { TaskState, type Task } from "@a2a-js/sdk";
import { RestUnsupportedOperationError } from "@a2a-js/sdk/errors";
import { describe, expect, it } from "vitest";
import {
  A2AAgent,
  A2AClient,
  A2ACallDeadlineError,
  A2ACancelOutcome,
  A2AMesh,
  A2AMeshUnsupportedError,
  A2AOriginError,
  A2AOriginSite,
  A2AProtocolError,
  A2ARemoteCallError,
  A2ARemoteCallReason,
} from "../../../src/a2a/index.js";
import { A2A_MESH_EXTENSION } from "../../../src/a2a/a2a-extension-uris.js";
import { peerOf } from "../../../src/a2a/client/a2a-card.js";
import { A2AClientOperation } from "../../../src/a2a/client/a2a-client-errors.js";
import { AGBOSS_MESH } from "../../../src/a2a/client/a2a-mesh-seam.js";
import { originPolicyOf } from "../../../src/a2a/client/a2a-origins.js";
import {
  A2ANetworkError,
  A2ANotSentError,
  wireFetchOf,
} from "../../../src/a2a/client/a2a-transport.js";
import { Waiter } from "../../../src/a2a/client/a2a-waiter.js";
import {
  isDefiniteSendFailure,
  isEndedAtSubscribe,
  isTransientWireError,
  rpcCodeOf,
} from "../../../src/a2a/client/a2a-wire-errors.js";
import { A2ACallerRejectedError } from "../../../src/a2a/a2a-caller.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Tool, type ToolHandler } from "../../../src/index.js";
import { testTool } from "../../../src/testing/index.js";
import { seconds, usd } from "../../../src/units/index.js";
import { callerOf } from "./fixtures/caller.js";
import { AGENT_URL, scripts, SdkAgent, urlOf, workingThen } from "./support/sdk-agent.js";
import { updatedTask } from "../../../src/a2a/client/a2a-task-view.js";
import { sentOf } from "../../../src/a2a/client/a2a-message.js";
import { reconciliationOf } from "../../../src/a2a/client/a2a-reconcile.js";
import { failureOf, outputOf } from "../../../src/a2a/client/a2a-outcome.js";
import {
  dataPartOf as dataPart,
  textPartOf as textPart,
} from "../../../src/a2a/client/a2a-parts.js";
import { A2APeerKind } from "../../../src/a2a/client/a2a-card.js";

/** A verdict's field, whatever its kind (#825: the reconciliation is a union by verdict). */
const fieldOf = (verdict: object, field: "reason" | "result"): unknown =>
  Reflect.get(verdict, field);

const protocol = (fields: { readonly rpcCode?: number; readonly httpStatus?: number }) =>
  new A2AProtocolError({ agent: "a", operation: A2AClientOperation.SendMessage, ...fields });
const protocolRpc = (rpcCode: number) => protocol({ rpcCode });

class AskOutputDto {
  @Text()
  status!: string;
}

describe("which codes certainly did nothing: an allowlist", () => {
  it("the codes before the agent acts are definite; a server's own or an unknown one is not", () => {
    for (const code of [-32700, -32600, -32601, -32602, -32001, -32004, -32005, -32008, -32009]) {
      expect(isDefiniteSendFailure(protocol({ rpcCode: code }))).toBe(true);
    }
    for (const code of [-32603, -32000, -32099, -32002, -32003, -32006, -32007, -1, 42]) {
      expect(isDefiniteSendFailure(protocol({ rpcCode: code }))).toBe(false);
    }
    expect(isDefiniteSendFailure(protocol({ httpStatus: 429 }))).toBe(false);
    expect(isDefiniteSendFailure(protocol({ httpStatus: 400 }))).toBe(true);
  });

  it("a request never sent is definite: nothing reached the agent", () => {
    expect(isDefiniteSendFailure(new A2ANotSentError(new Error("token refresh failed")))).toBe(
      true,
    );
  });
});

describe("one rule for what a wait may read again", () => {
  it("no answer, a 5xx, 408, 429, -32603 or an unreadable answer is transient", () => {
    expect(isTransientWireError(protocol({ httpStatus: 502 }))).toBe(true);
    expect(isTransientWireError(protocol({ httpStatus: 500 }))).toBe(true);
    expect(isTransientWireError(protocol({ httpStatus: 429 }))).toBe(true);
    expect(isTransientWireError(protocol({ httpStatus: 408 }))).toBe(true);
    expect(isTransientWireError(protocol({ rpcCode: -32603 }))).toBe(true);
    expect(isTransientWireError(protocol({}))).toBe(true);
  });

  it("any other code or 4xx, a refused caller, an origin refused ends the wait", () => {
    expect(isTransientWireError(protocol({ rpcCode: -32001 }))).toBe(false);
    expect(isTransientWireError(protocol({ httpStatus: 404 }))).toBe(false);
    expect(isTransientWireError(protocol({ httpStatus: 499 }))).toBe(false);
    expect(
      isTransientWireError(
        new A2ACallerRejectedError({ httpStatus: 401, wireCode: "a2a.caller-x", reason: "x" }),
      ),
    ).toBe(false);
    const origin = new A2AOriginError({
      agent: "a",
      origin: "https://e",
      site: A2AOriginSite.Request,
      allowedOrigins: [],
    });
    expect(isTransientWireError(origin)).toBe(false);
    expect(isTransientWireError(new Error("plain"))).toBe(false);
  });
});

describe("the HTTP+JSON binding's errors", () => {
  const policy = originPolicyOf("a", "https://agent.example/a2a");

  it("a REST error is given the A2A code of its kind: an ended task at subscribe is -32004", () => {
    expect(rpcCodeOf(new RestUnsupportedOperationError({ statusCode: 400 }))).toBe(-32004);
    expect(rpcCodeOf(new Error("x", { cause: new RestUnsupportedOperationError() }))).toBe(-32004);
  });

  it("a failed answer with an A2A error body reaches the SDK, whichever binding", async () => {
    const rest = Response.json(
      { error: { code: 400, status: "INVALID_ARGUMENT", message: "x", details: [] } },
      { status: 400 },
    );
    const answered = await wireFetchOf(
      () => Promise.resolve(rest),
      () => Promise.resolve({}),
      policy,
    )("https://agent.example/a2a");
    expect(answered.status).toBe(400);
  });

  it("an answer from another origin (a fetcher that followed a redirect itself) is refused", async () => {
    const followed = Object.defineProperty(Response.json({ ok: true }), "url", {
      value: "https://evil.example/a2a",
    });
    const fetcher = wireFetchOf(
      () => Promise.resolve(followed),
      () => Promise.resolve({}),
      policy,
    );
    await expect(fetcher("https://agent.example/a2a")).rejects.toBeInstanceOf(A2AOriginError);
  });
});

describe("a request that never left", () => {
  it("getHeaders() failing is A2ANotSentError, and nothing is sent", async () => {
    const agent = new SdkAgent({ script: scripts.messageEcho });
    class BrokenTokenClient extends A2AClient {
      protected override getHeaders(): Promise<Record<string, string>> {
        return Promise.reject(new Error("token service down"));
      }
    }

    const sent = new BrokenTokenClient({ url: AGENT_URL, fetcher: agent.fetcher }).send("hi");

    await expect(sent).rejects.toBeInstanceOf(A2ANotSentError);
    expect(agent.received).toEqual([]);
  });

  it("a call's key outside the outbound call's charset is refused before anything", async () => {
    const agent = new SdkAgent({ script: scripts.messageEcho });
    const client = new A2AClient({ url: AGENT_URL, fetcher: agent.fetcher });

    await expect(client.send("hi", { key: "order:42" })).rejects.toThrow(
      /\[a2a\.call-key-invalid\]/u,
    );
    await expect(client.send("hi", { key: "second-call" })).resolves.toMatchObject({ text: "HI" });
    expect(agent.count("SendMessage")).toBe(1);
  });
});

describe("the wait's own failures are never a dropped stream", () => {
  it("the caller's onEvent throwing ends the wait with its error, nothing read again", async () => {
    const agent = new SdkAgent({ script: workingThen(), streaming: true });
    const broken = new Error("the caller's callback broke");

    const run = new A2AClient({ url: AGENT_URL, fetcher: agent.fetcher }).send("hi", {
      onEvent: () => {
        throw broken;
      },
    });

    await expect(run).rejects.toBe(broken);
    expect(agent.count("SubscribeToTask")).toBe(1);
    expect(agent.count("GetTask")).toBe(0);
  });

  it("a message in a task's stream is malformed at once", async () => {
    const agent = new SdkAgent({ script: workingThen(), streaming: true });
    agent.rewrite = (method, answer) =>
      method === "SubscribeToTask"
        ? { ...answer, result: { message: { messageId: "x", role: "ROLE_AGENT", parts: [] } } }
        : undefined;

    const run = new A2AClient({ url: AGENT_URL, fetcher: agent.fetcher }).send("hi");

    await expect(run).rejects.toMatchObject({
      name: "A2ARemoteCallError",
      reason: A2ARemoteCallReason.MalformedAnswer,
    });
    expect(agent.count("SubscribeToTask")).toBe(1);
  });
});

describe("every event and read is of the waited task", () => {
  const otherTask = (answer: Record<string, unknown>): unknown => {
    const result = answer.result as Record<string, unknown> | undefined;
    const task = (result?.task ?? result) as Record<string, unknown> | undefined;
    return task === undefined
      ? undefined
      : {
          ...answer,
          result:
            result?.task === undefined
              ? { ...task, id: "someone-else" }
              : { task: { ...task, id: "someone-else" } },
        };
  };

  it("a streamed task of another id is malformed", async () => {
    const agent = new SdkAgent({ script: workingThen(), streaming: true });
    agent.rewrite = (method, answer) =>
      method === "SubscribeToTask" ? otherTask(answer) : undefined;

    await expect(
      new A2AClient({ url: AGENT_URL, fetcher: agent.fetcher }).send("hi"),
    ).rejects.toBeInstanceOf(A2ARemoteCallError);
  });

  it("a polled task of another id is malformed", async () => {
    const agent = new SdkAgent({ script: workingThen() });
    agent.rewrite = (method, answer) => (method === "GetTask" ? otherTask(answer) : undefined);

    await expect(
      new A2AClient({ url: AGENT_URL, fetcher: agent.fetcher }).send("hi"),
    ).rejects.toMatchObject({
      reason: A2ARemoteCallReason.MalformedAnswer,
    });
  });

  it("a 502 on the stream is a drop: the stream is opened again", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ text: "done" }), streaming: true });
    const held = new SdkAgent({ script: workingThen(), streaming: true });
    held.failStreams = 1;
    const run = new A2AClient({ url: AGENT_URL, fetcher: held.fetcher }).send("hi");

    await until(() => held.held.size > 0 && held.count("SubscribeToTask") >= 2);
    const [taskId] = held.held.keys();
    held.finish(taskId ?? "", TaskState.TASK_STATE_COMPLETED, { text: "done" });

    await expect(run).resolves.toMatchObject({ text: "done" });
    expect(held.count("SubscribeToTask")).toBe(2);
    expect(agent.received).toEqual([]);
  });
});

describe("remote strings never reach an error", () => {
  it("a card's versions are named only when they read as versions", async () => {
    const legacy = {
      name: "x",
      url: AGENT_URL,
      protocolVersion: "<b>steal@example.com</b>",
      supportedInterfaces: [{ protocolVersion: "0.3" }],
    };
    const agent = new SdkAgent({ script: scripts.messageEcho, rawCard: legacy });

    const refused = await new A2AClient({ url: AGENT_URL, fetcher: agent.fetcher })
      .send("hi")
      .catch((e: unknown) => e);

    expect(refused).toMatchObject({ protocolVersions: ["0.3"] });
    expect(String(refused)).not.toMatch(/steal/u);
  });

  it("a task id that is no safe id is malformed, never kept", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ text: "ok" }) });
    agent.rewrite = (method, answer) => {
      const task = (answer.result as { task?: Record<string, unknown> } | undefined)?.task;
      return method === "SendMessage" && task !== undefined
        ? { ...answer, result: { task: { ...task, id: "id with\nnewline <script>" } } }
        : undefined;
    };

    const sent = await new A2AClient({ url: AGENT_URL, fetcher: agent.fetcher })
      .send("hi")
      .catch((e: unknown) => e);

    expect(sent).toMatchObject({ reason: A2ARemoteCallReason.MalformedAnswer, taskId: undefined });
    expect(String(sent)).not.toMatch(/script/u);
  });

  it("a card that fails with a JSON-RPC-looking body is its status", async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        Response.json(
          { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "x" } },
          { status: 404 },
        ),
      );
    await expect(new A2AClient({ url: AGENT_URL, fetcher }).send("hi")).rejects.toMatchObject({
      httpStatus: 404,
      operation: "agent-card",
    });
  });
});

describe("how the cancel at a deadline went", () => {
  const working: Task = {
    id: "t-1",
    contextId: "c-1",
    status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
    artifacts: [],
    history: [],
    metadata: undefined,
  };
  /** A clock whose sleeps end at once: the deadline is reached at the first look. */
  const clock = { now: () => new Date(0), sleep: () => Promise.resolve() };
  const deadlineOf = async (cancelTask: () => Promise<Task>): Promise<unknown> => {
    const client = {
      getTask: () => Promise.resolve(working),
      resubscribeTask: () => {
        throw new Error("not streamed");
      },
      cancelTask,
    };
    const waiter = new Waiter({
      agent: "a",
      client,
      clock,
      taskId: "t-1",
      task: working,
      isStreaming: false,
      deadlineAt: new Date(0),
      signal: undefined,
      onEvent: undefined,
    });
    waiter.armDeadline();
    await new Promise((resolve) => setImmediate(resolve));
    return waiter.aborted().catch((error: unknown) => error);
  };

  it("canceled, answered in another state, refused, or no answer", async () => {
    const canceled = {
      ...working,
      status: { ...working.status, state: TaskState.TASK_STATE_CANCELED },
    } as Task;
    expect(await deadlineOf(() => Promise.resolve(canceled))).toMatchObject({
      cancel: A2ACancelOutcome.Canceled,
      isCanceled: true,
    });
    expect(await deadlineOf(() => Promise.resolve(working))).toMatchObject({
      cancel: A2ACancelOutcome.NotCanceled,
      isCanceled: false,
    });
    expect(await deadlineOf(() => Promise.reject(new Error("TaskNotCancelable")))).toMatchObject({
      cancel: A2ACancelOutcome.Refused,
    });
    expect(await deadlineOf(() => new Promise<Task>(() => undefined))).toMatchObject({
      cancel: A2ACancelOutcome.NoAnswer,
    });
    expect(await deadlineOf(() => Promise.resolve(working))).toBeInstanceOf(A2ACallDeadlineError);
  });
});

describe("the price is charged when the call is accepted", () => {
  it("a call that then runs out of time is charged its price all the same", async () => {
    const agent = new SdkAgent({ script: workingThen() });
    const { app, ask, errors } = await callerOf({ agent, price: usd(0.4), timeout: seconds(0.3) });

    const result = await ask("slow").finally(() => app.close());

    expect(errors[0]).toBeInstanceOf(A2ACallDeadlineError);
    expect(result.spend.byModel["a2a:caller-peer-a2a-agent"]).toBeCloseTo(0.4);
  });
});

describe("the mesh refused where it cannot ride", () => {
  class AskDto {
    @Text()
    text!: string;
  }

  it("under Required, a step with no call chain to send has no envelope: refused", async () => {
    const card = new SdkAgent({
      script: scripts.messageEcho,
      agboss: { idempotencyRetention: seconds(60) },
    }).card;
    @Tool({
      name: "sign-tool",
      description: "Signs a message",
      input: WorkflowStartTextDto,
      output: AskDto,
    })
    class SignTool implements ToolHandler<WorkflowStartTextDto, AskDto> {
      run(): Promise<AskDto> {
        const activation = AGBOSS_MESH.activate(card, peerOf(card), {
          agent: "a",
          application: "peer-application",
          skill: undefined,
          mesh: A2AMesh.Required,
        });
        activation.sign({
          messageId: "m",
          contextId: "",
          taskId: "",
          role: 1,
          parts: [],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        });
        return Promise.resolve({ text: "signed" });
      }
    }

    await expect(testTool(SignTool)({ text: "x" })).rejects.toBeInstanceOf(A2AMeshUnsupportedError);
    expect(card.capabilities?.extensions.some((each) => each.uri === A2A_MESH_EXTENSION)).toBe(
      true,
    );
  });

  it("the peer says mesh only once an envelope rode: outside an execution, none did", async () => {
    @A2AAgent({
      name: "peer-a2a-agent",
      url: AGENT_URL,
      target: { application: "peer-application" },
      mesh: A2AMesh.Required,
    })
    class PeerA2AAgent extends A2AClient {}
    const agent = new SdkAgent({
      script: scripts.messageEcho,
      agboss: { idempotencyRetention: seconds(60) },
    });

    const result = await new PeerA2AAgent({ fetcher: agent.fetcher }).send("hi");

    expect(result.peer.mesh).toBe(false);
    expect(agent.envelopes).toEqual([]);
  });
});

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !condition(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error("never reached");
}

describe("the remaining edges, one by one", () => {
  const of = { agent: "a", taskId: "t-1" };
  const task: Task = {
    id: "t-1",
    contextId: "c-1",
    status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
    artifacts: [
      {
        artifactId: "x",
        name: "",
        description: "",
        parts: [textPart("a")],
        metadata: undefined,
        extensions: [],
      },
    ],
    history: [],
    metadata: undefined,
  };
  const status = {
    state: TaskState.TASK_STATE_COMPLETED,
    message: undefined,
    timestamp: undefined,
  };
  const artifact = (id: string, text: string) => ({
    artifactId: id,
    name: "",
    description: "",
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
  });

  it("a status update changes this task's status; another task's is malformed", () => {
    const update = { taskId: "t-1", contextId: "c-1", status, metadata: undefined };
    expect(updatedTask(of, task, { payload: { $case: "statusUpdate", value: update } })).toEqual({
      ...task,
      status,
    });
    expect(
      updatedTask(of, undefined, { payload: { $case: "statusUpdate", value: update } }),
    ).toBeUndefined();
    expect(() =>
      updatedTask(of, task, {
        payload: { $case: "statusUpdate", value: { ...update, taskId: "t-2" } },
      }),
    ).toThrow(A2ARemoteCallError);
  });

  it("an artifact update appends to its artifact, replaces it, or adds one; another task's is malformed", () => {
    const update = (id: string, text: string, append: boolean, taskId = "t-1") => ({
      payload: {
        $case: "artifactUpdate" as const,
        value: {
          taskId,
          contextId: "c-1",
          artifact: artifact(id, text),
          append,
          lastChunk: false,
          metadata: undefined,
        },
      },
    });
    const parts = (changed: Task | undefined) =>
      changed?.artifacts.map((each) => [each.artifactId, each.parts.length]);

    expect(parts(updatedTask(of, task, update("x", "b", true)))).toEqual([["x", 2]]);
    expect(parts(updatedTask(of, task, update("x", "b", false)))).toEqual([["x", 1]]);
    expect(parts(updatedTask(of, task, update("y", "b", true)))).toEqual([
      ["x", 1],
      ["y", 1],
    ]);
    expect(updatedTask(of, undefined, update("x", "b", true))).toBeUndefined();
    const noArtifact = {
      payload: {
        $case: "artifactUpdate" as const,
        value: { ...update("x", "b", true).payload.value, artifact: undefined },
      },
    };
    expect(updatedTask(of, task, noArtifact)).toBe(task);
    expect(() => updatedTask(of, task, update("x", "b", true, "t-2"))).toThrow(A2ARemoteCallError);
  });

  it("a whole task replaces it; a message or nothing in the event", () => {
    expect(updatedTask(of, undefined, { payload: { $case: "task", value: task } })).toBe(task);
    expect(updatedTask(of, task, { payload: undefined })).toBe(task);
    expect(updatedTask(of, task, {})).toBe(task);
  });

  it("a network failure is transient; only -32004 says the task ended at subscribe", () => {
    expect(isTransientWireError(new A2ANetworkError(new TypeError("x")))).toBe(true);
    expect(isEndedAtSubscribe(new Error("x", { cause: protocolRpc(-32004) }))).toBe(true);
    expect(isEndedAtSubscribe(protocolRpc(-32001))).toBe(false);
    expect(isEndedAtSubscribe(new Error("x"))).toBe(false);
  });

  it("A2ANotSentError says it was not sent and keeps its cause; a failing sign is one", async () => {
    const cause = new Error("no signing key");
    expect(new A2ANotSentError(cause)).toMatchObject({
      name: "A2ANotSentError",
      message: "the A2A request was not sent: what it needed first failed",
      cause,
    });
    const call = {
      agent: "a",
      url: AGENT_URL,
      peer: { kind: A2APeerKind.Foreign, idempotencyRetention: undefined, mesh: false } as const,
      client: {
        sendMessage: () => Promise.reject(new Error("never")),
        getTask: () => Promise.reject(new Error("never")),
      },
      clock: { now: () => new Date(0), sleep: () => Promise.resolve() },
      parts: [],
      skill: undefined,
      contextId: undefined,
      taskId: undefined,
      key: undefined,
      sign: () => {
        throw cause;
      },
      signal: undefined,
    };
    await expect(sentOf(call, "m")).rejects.toMatchObject({ name: "A2ANotSentError", cause });
  });

  it("a task with a safe id but an unsafe context id is malformed", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ text: "ok" }) });
    agent.rewrite = (method, answer) => {
      const sent = (answer.result as { task?: Record<string, unknown> } | undefined)?.task;
      return method === "SendMessage" && sent !== undefined
        ? { ...answer, result: { task: { ...sent, contextId: "bad context!" } } }
        : undefined;
    };
    await expect(
      new A2AClient({ url: AGENT_URL, fetcher: agent.fetcher }).send("hi"),
    ).rejects.toMatchObject({
      reason: A2ARemoteCallReason.MalformedAnswer,
    });
  });

  it("a typed output: none in a message (no task), none in a task, nothing at all", () => {
    const message = {
      messageId: "m",
      contextId: "",
      taskId: "",
      role: 2,
      parts: [],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };
    const completed = { ...task, status, artifacts: [] };
    expect(() => outputOf("a", AskOutputDto, undefined, message)).toThrow(
      expect.objectContaining({
        agent: "a",
        reason: A2ARemoteCallReason.NoTask,
        taskId: undefined,
      }),
    );
    expect(() => outputOf("a", AskOutputDto, completed, undefined)).toThrow(
      expect.objectContaining({ reason: A2ARemoteCallReason.NoOutput, taskId: "t-1" }),
    );
    expect(() => outputOf("a", AskOutputDto, undefined, undefined)).toThrow(
      expect.objectContaining({ reason: A2ARemoteCallReason.NoTask }),
    );
    const answered = {
      ...completed,
      artifacts: [{ ...artifact("x", "z"), parts: [dataPart({ status: "paid" })] }],
    };
    expect(outputOf("a", AskOutputDto, answered, undefined)).toEqual({ status: "paid" });
  });

  it("a stored request that is no object has no peer: unknown", async () => {
    const foreign = {
      kind: A2APeerKind.Foreign,
      idempotencyRetention: undefined,
      mesh: false,
    } as const;
    const call = {
      agent: "a",
      url: AGENT_URL,
      peer: foreign,
      client: {
        sendMessage: () => Promise.reject(new Error("never")),
        getTask: () => Promise.reject(new Error("never")),
      },
      clock: { now: () => new Date(0), sleep: () => Promise.resolve() },
      parts: [],
      skill: undefined,
      contextId: undefined,
      taskId: undefined,
      key: undefined,
      sign: () => ({ metadata: {}, serviceParameters: {} }),
      signal: undefined,
    };
    for (const storedRequest of ["null", "7", '"text"']) {
      const verdict = await reconciliationOf(call, { storedRequest }, "m");
      expect(fieldOf(verdict, "reason")).toMatch(/agent changed/u);
    }
  });

  it("an opaque redirect is a redirect: followed on the client's origins", async () => {
    const policy = originPolicyOf("a", "https://agent.example/a2a");
    const opaque = Object.defineProperties(
      new Response(null, { status: 200, headers: { location: "/card2.json" } }),
      {
        type: { value: "opaqueredirect" },
        ok: { value: false },
      },
    );
    const answers = [opaque, Response.json({ card: 2 })];
    const seen: string[] = [];
    const fetcher = wireFetchOf(
      (input) => {
        seen.push(urlOf(input));
        return Promise.resolve(answers.shift() ?? new Response(null, { status: 599 }));
      },
      () => Promise.resolve({}),
      policy,
    );

    await expect((await fetcher("https://agent.example/card.json")).json()).resolves.toEqual({
      card: 2,
    });
    expect(seen).toEqual(["https://agent.example/card.json", "https://agent.example/card2.json"]);
  });
});

describe("a task that ended before the stream was opened", () => {
  it("the agent's -32004 at subscribe is read, and GetTask gives how it ended", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ text: "done" }), streaming: true });
    // the accept's answer says WORKING: the task ends before the client subscribes
    agent.rewrite = (method, answer) => {
      const sent = (answer.result as { task?: Record<string, unknown> } | undefined)?.task;
      return method === "SendMessage" && sent !== undefined
        ? { ...answer, result: { task: { ...sent, status: { state: "TASK_STATE_WORKING" } } } }
        : undefined;
    };

    const result = await new A2AClient({ url: AGENT_URL, fetcher: agent.fetcher }).send("hi");

    expect(result.text).toBe("done");
    expect(agent.count("SubscribeToTask")).toBe(1);
    expect(agent.count("GetTask")).toBe(1);
  });
});

describe("the second review's edges", () => {
  it("a read never sent (getHeaders failed) is transient for a wait", () => {
    expect(isTransientWireError(new A2ANotSentError(new Error("token")))).toBe(true);
  });

  it("an unsafe context id is never put on a task's error", () => {
    const failed: Task = {
      id: "t-1",
      contextId: "ctx with spaces <x>",
      status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: undefined },
      artifacts: [],
      history: [],
      metadata: undefined,
    };
    expect(failureOf(failed, "a")).toMatchObject({ contextId: "" });
    expect(failureOf({ ...failed, contextId: "c-1" }, "a")).toMatchObject({ contextId: "c-1" });
  });

  it("another task's CANCELED answer is no cancel of this one", async () => {
    const working: Task = {
      id: "t-1",
      contextId: "bad context <x>",
      status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
      artifacts: [],
      history: [],
      metadata: undefined,
    };
    const other = {
      ...working,
      id: "t-2",
      status: { ...working.status, state: TaskState.TASK_STATE_CANCELED },
    } as Task;
    const waiter = new Waiter({
      agent: "a",
      client: {
        getTask: () => Promise.resolve(working),
        resubscribeTask: () => {
          throw new Error("not streamed");
        },
        cancelTask: () => Promise.resolve(other),
      },
      clock: { now: () => new Date(0), sleep: () => Promise.resolve() },
      taskId: "t-1",
      task: working,
      isStreaming: false,
      deadlineAt: new Date(0),
      signal: undefined,
      onEvent: undefined,
    });
    waiter.armDeadline();
    await new Promise((resolve) => setImmediate(resolve));

    const error = await waiter.aborted().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ cancel: A2ACancelOutcome.NotCanceled, contextId: "" });
  });
});
