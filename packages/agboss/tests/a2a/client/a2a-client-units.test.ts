/**
 * #809 — the client's payment-relevant pieces one by one (the `a2a-client` mutation shard): the
 * deterministic messageId, the mesh body hash, which failures are definite, how errors are
 * translated (codes only), the origin policy and the fetch every request goes through, the outcome
 * of each task state, and how a pending accept is reconciled by peer.
 */
import { TaskState, type Task } from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import {
  JsonRpcTaskNotFoundError,
  JsonRpcTransportError,
  RestTaskNotFoundError,
} from "@a2a-js/sdk/errors";
import { describe, expect, it } from "vitest";
import { urlOf } from "./support/sdk-agent.js";
import { A2ACallerRejectedError } from "../../../src/a2a/a2a-caller.js";
import {
  meshBodyHashOf,
  meshEnvelopeTextOf,
  meshReportTextOf,
  meshSignedPartOf,
} from "../../../src/a2a/a2a-mesh-message.js";
import { callNameOf, isAmbiguous } from "../../../src/a2a/client/a2a-accept.js";
import { messageIdOf, type AcceptCall } from "../../../src/a2a/client/a2a-message.js";
import {
  acceptRequestOf,
  notSentOf,
  reconciliationOf,
} from "../../../src/a2a/client/a2a-reconcile.js";
import { A2APeerKind, type A2ARemotePeer } from "../../../src/a2a/client/a2a-card.js";
import { artifactPartsOf, dataPartOf, textPartOf } from "../../../src/a2a/client/a2a-parts.js";
import { A2A_SKILLS_EXTENSION } from "../../../src/a2a/a2a-extension-uris.js";
import {
  A2AClientOperation,
  A2AProtocolError,
  A2ARemoteCallError,
  remoteCodeOf,
} from "../../../src/a2a/client/a2a-client-errors.js";
import { A2AOriginError, A2AOriginSite } from "../../../src/a2a/client/a2a-guard-errors.js";
import {
  A2ATaskCanceledError,
  A2ATaskEnd,
  A2ATaskFailedError,
  A2ATaskInterruptedError,
  A2ATaskInterruption,
} from "../../../src/a2a/client/a2a-task-errors.js";
import {
  failureOf,
  isInterrupted,
  isSettled,
  stateOf,
} from "../../../src/a2a/client/a2a-outcome.js";
import {
  isAllowedOrigin,
  originPolicyOf,
  originRefusalOf,
} from "../../../src/a2a/client/a2a-origins.js";
import {
  A2ANetworkError,
  HttpStatusError,
  sdkClientOf,
  wireFetchOf,
} from "../../../src/a2a/client/a2a-transport.js";
import {
  isDefiniteSendFailure,
  MAX_CAUSES,
  rpcCodeOf,
  wireErrorOf,
} from "../../../src/a2a/client/a2a-wire-errors.js";
import { NotSentTrust } from "../../../src/app/outbound-call-contract.js";
import { OutboundCallVerdict } from "../../../src/app/outbound-calls.js";
import { HopsLimitExceededError, MeshLoopDetectedError } from "../../../src/index.js";
import { hours } from "../../../src/units/index.js";

/** A verdict's field, whatever its kind (#825: the reconciliation is a union by verdict). */
const fieldOf = (verdict: object, field: "reason" | "result"): unknown =>
  Reflect.get(verdict, field);

const MESH = "https://agboss.dev/a2a/mesh/v1";
const SKILLS = "https://agboss.dev/a2a/skills/v1";

describe("artifactPartsOf: the finish's output artifact when the task has one", () => {
  const artifactOf = (text: string, metadata?: Record<string, unknown>) => ({
    artifactId: text,
    name: "",
    description: "",
    parts: [textPartOf(text)],
    metadata,
    extensions: [],
  });
  const textsOf = (...artifacts: ReturnType<typeof artifactOf>[]) =>
    artifactPartsOf(artifacts).map((part) =>
      part.content?.$case === "text" ? part.content.value : "",
    );
  const finish = { [A2A_SKILLS_EXTENSION]: { finish: "answer-workflow-finish" } };

  it("an AGBoss task: the output artifact alone, beside a streamed one", () => {
    expect(textsOf(artifactOf("stream"), artifactOf("output", finish))).toEqual(["output"]);
  });

  it("no finish named (a foreign task, a malformed entry): every artifact, in order", () => {
    expect(textsOf(artifactOf("a"), artifactOf("b"))).toEqual(["a", "b"]);
    expect(
      textsOf(
        artifactOf("null", { [A2A_SKILLS_EXTENSION]: null }),
        artifactOf("text", { [A2A_SKILLS_EXTENSION]: "answer-workflow-finish" }),
        artifactOf("number", { [A2A_SKILLS_EXTENSION]: { finish: 7 } }),
        artifactOf("other", { "https://other.example/ext": { finish: "x" } }),
      ),
    ).toEqual(["null", "text", "number", "other"]);
  });
});

describe("messageIdOf", () => {
  it("is one UUID (version 5 layout) per tenant and key, the same every time", () => {
    const id = messageIdOf("acme", "exec-1:ask-agent:1:call_1");

    expect(id).toBe(messageIdOf("acme", "exec-1:ask-agent:1:call_1"));
    expect(id).toBe("e8d24875-fd77-5438-b1a7-c484d7069ad5"); // pinned: a stored call's id never moves
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(messageIdOf("globex", "exec-1:ask-agent:1:call_1")).not.toBe(id);
    expect(messageIdOf("acme", "exec-1:ask-agent:1:call_2")).not.toBe(id);
    // the tenant and the key are apart: "a" + "b\0c" is not "a\0b" + "c"
    expect(messageIdOf("a", "b\u0000c")).not.toBe(messageIdOf("a\u0000b", "c"));
  });

  it("sets the variant bits on any hash", () => {
    for (const key of ["k-0", "k-1", "k-2", "k-3", "k-4", "k-5", "k-6", "k-7"]) {
      expect(messageIdOf("t", key)[19]).toMatch(/[89ab]/u);
    }
  });
});

describe("the mesh on a message", () => {
  const message = {
    messageId: "m-1",
    role: "ROLE_USER",
    parts: [{ text: "hi" }],
    metadata: { [MESH]: { envelope: "e.n.v" }, [SKILLS]: { skill: "s" } },
  };

  it("the signed part is the message without its mesh entry, other metadata kept", () => {
    expect(meshSignedPartOf(message)).toEqual({
      messageId: "m-1",
      role: "ROLE_USER",
      parts: [{ text: "hi" }],
      metadata: { [SKILLS]: { skill: "s" } },
    });
  });

  it("metadata that holds only the mesh entry goes with it", () => {
    const only = { messageId: "m-1", metadata: { [MESH]: { envelope: "x" } } };
    expect(meshSignedPartOf(only)).toEqual({ messageId: "m-1" });
    expect(meshSignedPartOf({ messageId: "m-1" })).toEqual({ messageId: "m-1" });
    expect(meshSignedPartOf({ messageId: "m-1", metadata: null })).toEqual({
      messageId: "m-1",
      metadata: null,
    });
    expect(meshSignedPartOf("text")).toBe("text");
    expect(meshSignedPartOf(null)).toBeNull();
  });

  it("the hash is the same with a fresh envelope, another with another body", () => {
    const resent = { ...message, metadata: { ...message.metadata, [MESH]: { envelope: "other" } } };
    const changed = { ...message, parts: [{ text: "bye" }] };

    expect(meshBodyHashOf(message)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(meshBodyHashOf(resent)).toBe(meshBodyHashOf(message));
    expect(meshBodyHashOf(changed)).not.toBe(meshBodyHashOf(message));
    // canonical: key order does not count
    const reordered = {
      metadata: message.metadata,
      parts: message.parts,
      role: message.role,
      messageId: "m-1",
    };
    expect(meshBodyHashOf(reordered)).toBe(meshBodyHashOf(message));
  });

  it("reads the envelope of a message and the report of a task", () => {
    expect(meshEnvelopeTextOf(message)).toBe("e.n.v");
    expect(meshEnvelopeTextOf({ metadata: { [MESH]: { envelope: 7 } } })).toBeUndefined();
    expect(meshEnvelopeTextOf({ metadata: { [MESH]: "e" } })).toBeUndefined();
    expect(meshEnvelopeTextOf({ metadata: null })).toBeUndefined();
    expect(meshEnvelopeTextOf(null)).toBeUndefined();
    expect(meshReportTextOf({ metadata: { [MESH]: { report: "r.e.p" } } })).toBe("r.e.p");
    expect(meshReportTextOf({ metadata: { [MESH]: { report: 1 } } })).toBeUndefined();
    expect(meshReportTextOf({ metadata: { [MESH]: [] } })).toBeUndefined();
    expect(meshReportTextOf({ metadata: undefined })).toBeUndefined();
    expect(meshReportTextOf(undefined)).toBeUndefined();
  });
});

const protocol = (fields: Partial<ConstructorParameters<typeof A2AProtocolError>[0]>) =>
  new A2AProtocolError({ agent: "a", operation: A2AClientOperation.SendMessage, ...fields });

describe("which failed sends did nothing", () => {
  it("a refused caller, a JSON-RPC error but -32603, a 4xx but 408 are definite", () => {
    expect(
      isDefiniteSendFailure(
        new A2ACallerRejectedError({
          httpStatus: 403,
          wireCode: "a2a.caller-forbidden",
          reason: "x",
        }),
      ),
    ).toBe(true);
    expect(isDefiniteSendFailure(protocol({ rpcCode: -32602 }))).toBe(true);
    expect(isDefiniteSendFailure(protocol({ rpcCode: -32603 }))).toBe(false);
    expect(isDefiniteSendFailure(protocol({ httpStatus: 400 }))).toBe(true);
    expect(isDefiniteSendFailure(protocol({ httpStatus: 499 }))).toBe(true);
    expect(isDefiniteSendFailure(protocol({ httpStatus: 408 }))).toBe(false);
    expect(isDefiniteSendFailure(protocol({ httpStatus: 399 }))).toBe(false);
    expect(isDefiniteSendFailure(protocol({ httpStatus: 500 }))).toBe(false);
    expect(isDefiniteSendFailure(protocol({}))).toBe(false);
    expect(isDefiniteSendFailure(new A2ANetworkError(new TypeError("x")))).toBe(false);
    expect(isDefiniteSendFailure(new Error("x"))).toBe(false);
  });

  it("only a network failure or an indefinite protocol error is ambiguous (asked again)", () => {
    expect(isAmbiguous(new A2ANetworkError(new TypeError("x")))).toBe(true);
    expect(isAmbiguous(protocol({ httpStatus: 503 }))).toBe(true);
    expect(isAmbiguous(protocol({ rpcCode: -32603 }))).toBe(true);
    expect(isAmbiguous(protocol({ rpcCode: -32602 }))).toBe(false);
    expect(
      isAmbiguous(
        new A2ACallerRejectedError({ httpStatus: 401, wireCode: "a2a.caller-x", reason: "x" }),
      ),
    ).toBe(false);
    expect(isAmbiguous(new Error("an OutboundCalls refusal"))).toBe(false);
  });
});

describe("wireErrorOf: codes only", () => {
  const op = A2AClientOperation.GetTask;

  it("the signal's reason when it ended the call", () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    controller.abort(reason);
    expect(wireErrorOf(new Error("aborted"), "a", op, controller.signal)).toBe(reason);
    expect(wireErrorOf(new Error("x"), "a", op, new AbortController().signal)).toBeInstanceOf(
      A2AProtocolError,
    );
  });

  it("passes the client's own errors through, found in the causes", () => {
    const network = new A2ANetworkError(new TypeError("reset"));
    const refused = new A2ACallerRejectedError({
      httpStatus: 401,
      wireCode: "a2a.caller-x",
      reason: "x",
    });
    const origin = new A2AOriginError({
      agent: "a",
      origin: "https://e",
      site: A2AOriginSite.Request,
      allowedOrigins: [],
    });
    const known = protocol({ httpStatus: 502 });
    for (const error of [network, refused, origin, known]) {
      expect(wireErrorOf(new Error("wrapped", { cause: error }), "a", op)).toBe(error);
    }
  });

  it("a JSON-RPC error keeps its code, not its message", () => {
    const rpc = new JsonRpcTaskNotFoundError({
      message: "task t-1 of bob@example.com",
      envelopeCode: -32001,
    });
    const translated = wireErrorOf(
      new Error("SSE event contained an error", { cause: rpc }),
      "a",
      op,
    );

    expect(translated).toMatchObject({ rpcCode: -32001, operation: op, agent: "a" });
    expect(String(translated)).not.toMatch(/bob/);
    expect(rpcCodeOf(rpc)).toBe(-32001);
    expect(rpcCodeOf(new Error("x"))).toBeUndefined();
    const raw = new JsonRpcTransportError({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32099, message: "secret" },
    });
    expect(wireErrorOf(raw, "a", op)).toMatchObject({ rpcCode: -32099 });
  });

  it("anything else is a protocol error without its text", () => {
    const translated = wireErrorOf(new Error("Failed to parse SSE event data: {secret}"), "a", op);
    expect(translated).toBeInstanceOf(A2AProtocolError);
    expect(translated).toMatchObject({ rpcCode: undefined, httpStatus: undefined });
    expect(String(translated)).not.toMatch(/secret/);
  });

  it("a cause chain that loops ends", () => {
    const first = new Error("a");
    const second = new Error("b", { cause: first });
    Object.defineProperty(first, "cause", { value: second });
    expect(wireErrorOf(first, "a", op)).toBeInstanceOf(A2AProtocolError);
  });
});

describe("the origins a client talks to", () => {
  it("its url's origin and the listed ones", () => {
    const policy = originPolicyOf("a", "https://billing.example/a2a", ["https://rpc.example:8443"]);

    expect(policy.origins).toEqual(["https://billing.example", "https://rpc.example:8443"]);
    expect(isAllowedOrigin(policy, "https://billing.example/other")).toBe(true);
    expect(isAllowedOrigin(policy, "https://rpc.example:8443/a2a")).toBe(true);
    expect(isAllowedOrigin(policy, "https://rpc.example/a2a")).toBe(false); // another port
    expect(isAllowedOrigin(policy, "http://billing.example/a2a")).toBe(false); // another scheme
    expect(isAllowedOrigin(policy, "not a url")).toBe(false);
    expect(
      originRefusalOf(policy, "https://billing.example/x", A2AOriginSite.Request),
    ).toBeUndefined();
    expect(originRefusalOf(policy, "https://evil.example/x", A2AOriginSite.Redirect)).toMatchObject(
      {
        origin: "https://evil.example",
        site: A2AOriginSite.Redirect,
        allowedOrigins: policy.origins,
      },
    );
    expect(originRefusalOf(policy, "nope", A2AOriginSite.Request)?.origin).toBe("(no origin)");
  });

  it("a url or an entry that is no origin is refused", () => {
    expect(() => originPolicyOf("a", "/relative")).toThrow(/\[a2a\.url-invalid\]/);
    expect(() => originPolicyOf("a", "https://b.example", ["https://b.example/"])).toThrow(
      /allowed-origin-invalid/,
    );
    expect(() => originPolicyOf("a", "https://b.example", ["data:text/plain,x"])).toThrow(
      /allowed-origin-invalid/,
    );
    expect(originPolicyOf("a", "https://b.example", ["https://b.example"]).origins).toEqual([
      "https://b.example",
    ]);
  });
});

describe("wireFetchOf", () => {
  const policy = originPolicyOf("a", "https://agent.example/a2a");
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const answering =
    (...responses: Response[]): typeof fetch =>
    (input, init) => {
      calls.push({ url: urlOf(input), init });
      return Promise.resolve(responses.shift() ?? new Response("", { status: 599 }));
    };

  it("adds the headers (the SDK's last), never follows a redirect itself", async () => {
    calls.length = 0;
    const fetcher = wireFetchOf(
      answering(Response.json({ ok: 1 })),
      () => Promise.resolve({ authorization: "B", "a2a-version": "0" }),
      policy,
    );

    await fetcher("https://agent.example/a2a", {
      method: "POST",
      headers: { "A2A-Version": "1.0" },
    });

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("B");
    expect(headers.get("a2a-version")).toBe("1.0");
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it("sends nothing to another origin", async () => {
    calls.length = 0;
    const fetcher = wireFetchOf(answering(), () => Promise.resolve({ authorization: "B" }), policy);

    await expect(fetcher("https://evil.example/a2a", { method: "POST" })).rejects.toBeInstanceOf(
      A2AOriginError,
    );
    expect(calls).toEqual([]);
  });

  it("a GET follows a redirect on its origins, at most three; elsewhere is refused", async () => {
    calls.length = 0;
    const to = (location: string) => new Response(null, { status: 307, headers: { location } });
    const followed = wireFetchOf(
      answering(to("/card2.json"), Response.json({ card: 1 })),
      () => Promise.resolve({}),
      policy,
    );
    await expect((await followed("https://agent.example/card.json")).json()).resolves.toEqual({
      card: 1,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://agent.example/card.json",
      "https://agent.example/card2.json",
    ]);

    const away = wireFetchOf(
      answering(to("https://evil.example/card.json")),
      () => Promise.resolve({}),
      policy,
    );
    await expect(away("https://agent.example/card.json")).rejects.toMatchObject({
      site: A2AOriginSite.Redirect,
    });

    const endless = wireFetchOf(
      answering(to("/1"), to("/2"), to("/3"), to("/4")),
      () => Promise.resolve({}),
      policy,
    );
    await expect(endless("https://agent.example/card.json")).rejects.toThrow(/HTTP 307/);

    const noLocation = wireFetchOf(
      answering(new Response(null, { status: 302 })),
      () => Promise.resolve({}),
      policy,
    );
    await expect(noLocation("https://agent.example/card.json")).rejects.toThrow(/HTTP 302/);

    const post = wireFetchOf(answering(to("/elsewhere")), () => Promise.resolve({}), policy);
    await expect(post("https://agent.example/a2a", { method: "POST" })).rejects.toThrow(/HTTP 307/);
  });

  it("a network failure is A2ANetworkError, an aborted one its reason", async () => {
    const failing: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    await expect(
      wireFetchOf(failing, () => Promise.resolve({}), policy)("https://agent.example/a2a"),
    ).rejects.toBeInstanceOf(A2ANetworkError);
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(
      wireFetchOf(
        failing,
        () => Promise.resolve({}),
        policy,
      )("https://agent.example/a2a", { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("a refused caller is read from a 401 / 403 with an a2a.caller-* code only", async () => {
    const fetch401 = (body: unknown, status = 401) =>
      wireFetchOf(
        answering(Response.json(body, { status })),
        () => Promise.resolve({}),
        policy,
      )("https://agent.example/a2a");

    await expect(
      fetch401({ code: "a2a.caller-unauthenticated", error: "who are you, eve@example.com" }),
    ).rejects.toMatchObject({
      httpStatus: 401,
      wireCode: "a2a.caller-unauthenticated",
    });
    await expect(fetch401({ code: "a2a.caller-forbidden" }, 403)).rejects.toBeInstanceOf(
      A2ACallerRejectedError,
    );
    await expect(fetch401({ code: "a2a.caller-forbidden" }, 402)).rejects.toThrow(/HTTP 402/);
    await expect(fetch401({ code: "mesh.signature-invalid" })).rejects.toThrow(/HTTP 401/);
    await expect(fetch401({ code: 7 })).rejects.toThrow(/HTTP 401/);
    await expect(fetch401("plain")).rejects.toThrow(/HTTP 401/);
    const refused = await fetch401({ code: "a2a.caller-x", error: "eve@example.com" }).catch(
      (error: unknown) => error,
    );
    expect(String(refused)).not.toMatch(/eve/);
  });

  it("a failed answer that is a JSON-RPC error goes to the SDK; any other is its status", async () => {
    const rpc = Response.json(
      { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "x" } },
      { status: 404 },
    );
    const rpcRequest = {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask" }),
    };
    const passed = await wireFetchOf(
      answering(rpc),
      () => Promise.resolve({}),
      policy,
    )("https://agent.example/a2a", rpcRequest);
    expect(passed.status).toBe(404);
    // one binding's error body for the other's request is a status: never handed on to be lost
    const restBodyForRpc = wireFetchOf(
      answering(Response.json({ error: { code: 403, message: "x" } }, { status: 403 })),
      () => Promise.resolve({}),
      policy,
    );
    await expect(restBodyForRpc("https://agent.example/a2a", rpcRequest)).rejects.toThrow(
      /HTTP 403/,
    );
    const rpcBodyForRest = wireFetchOf(
      answering(Response.json({ jsonrpc: "2.0", error: { code: -32001 } }, { status: 404 })),
      () => Promise.resolve({}),
      policy,
    );
    await expect(rpcBodyForRest("https://agent.example/a2a/tasks/t-1")).rejects.toThrow(/HTTP 404/);
    // an HTTP+JSON request with a JSON body is no JSON-RPC one: its own error body goes to the SDK
    const restAnswer = await wireFetchOf(
      answering(Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 })),
      () => Promise.resolve({}),
      policy,
    )("https://agent.example/a2a/message:send", {
      method: "POST",
      body: JSON.stringify({ message: {} }),
    });
    expect(restAnswer.status).toBe(404);
    const notJson = wireFetchOf(
      answering(Response.json({ error: { code: 1 } }, { status: 400 })),
      () => Promise.resolve({}),
      policy,
    );
    const notJsonAnswer = await notJson("https://agent.example/a2a", {
      method: "POST",
      body: "not json",
    });
    expect(notJsonAnswer.status).toBe(400);
    const other = wireFetchOf(
      answering(Response.json({ error: "x" }, { status: 404 })),
      () => Promise.resolve({}),
      policy,
    );
    await expect(other("https://agent.example/a2a")).rejects.toThrow(/HTTP 404/);
    const jsonrpcOnly = wireFetchOf(
      answering(Response.json({ jsonrpc: "2.0" }, { status: 500 })),
      () => Promise.resolve({}),
      policy,
    );
    await expect(jsonrpcOnly("https://agent.example/a2a")).rejects.toThrow(/HTTP 500/);
  });
});

const taskIn = (state: TaskState | undefined, metadata?: Record<string, unknown>): Task => ({
  id: "t-1",
  contextId: "c-1",
  status:
    state === undefined
      ? undefined
      : {
          state,
          message:
            metadata === undefined
              ? undefined
              : {
                  messageId: "s",
                  contextId: "c-1",
                  taskId: "t-1",
                  role: 2,
                  parts: [],
                  metadata,
                  extensions: [],
                  referenceTaskIds: [],
                },
          timestamp: undefined,
        },
  artifacts: [],
  history: [],
  metadata: undefined,
});

describe("each task state's outcome", () => {
  it("settled: terminal or interrupted; working is not", () => {
    for (const state of [
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_REJECTED,
      TaskState.TASK_STATE_INPUT_REQUIRED,
      TaskState.TASK_STATE_AUTH_REQUIRED,
    ]) {
      expect(isSettled(taskIn(state))).toBe(true);
    }
    for (const state of [
      TaskState.TASK_STATE_SUBMITTED,
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_UNSPECIFIED,
      undefined,
    ]) {
      expect(isSettled(taskIn(state))).toBe(false);
    }
    expect(isInterrupted(taskIn(TaskState.TASK_STATE_INPUT_REQUIRED))).toBe(true);
    expect(isInterrupted(taskIn(TaskState.TASK_STATE_AUTH_REQUIRED))).toBe(true);
    expect(isInterrupted(taskIn(TaskState.TASK_STATE_COMPLETED))).toBe(false);
    expect(isInterrupted(taskIn(undefined))).toBe(false);
    expect(stateOf(taskIn(undefined))).toBeUndefined();
  });

  it("maps each state to its error", () => {
    expect(failureOf(taskIn(TaskState.TASK_STATE_COMPLETED), "a")).toBeUndefined();
    expect(failureOf(taskIn(TaskState.TASK_STATE_FAILED), "a")).toMatchObject({
      end: A2ATaskEnd.Failed,
      remoteCode: undefined,
      taskId: "t-1",
      contextId: "c-1",
      agent: "a",
    });
    expect(failureOf(taskIn(TaskState.TASK_STATE_REJECTED), "a")).toMatchObject({
      end: A2ATaskEnd.Rejected,
    });
    expect(
      failureOf(taskIn(TaskState.TASK_STATE_FAILED, { [MESH]: { code: "a2a.start-lost" } }), "a"),
    ).toMatchObject({
      remoteCode: "a2a.start-lost",
    });
    expect(
      failureOf(taskIn(TaskState.TASK_STATE_FAILED, { [MESH]: { code: "Not A Code!" } }), "a"),
    ).toMatchObject({ remoteCode: undefined });
    expect(failureOf(taskIn(TaskState.TASK_STATE_FAILED, { [MESH]: "x" }), "a")).toBeInstanceOf(
      A2ATaskFailedError,
    );
    expect(failureOf(taskIn(TaskState.TASK_STATE_CANCELED), "a")).toBeInstanceOf(
      A2ATaskCanceledError,
    );
    expect(failureOf(taskIn(TaskState.TASK_STATE_INPUT_REQUIRED), "a")).toMatchObject({
      interruption: A2ATaskInterruption.InputRequired,
    });
    expect(failureOf(taskIn(TaskState.TASK_STATE_AUTH_REQUIRED), "a")).toBeInstanceOf(
      A2ATaskInterruptedError,
    );
    expect(failureOf(taskIn(TaskState.TASK_STATE_AUTH_REQUIRED), "a")).toMatchObject({
      interruption: A2ATaskInterruption.AuthRequired,
    });
    expect(failureOf(taskIn(TaskState.TASK_STATE_UNSPECIFIED), "a")).toBeInstanceOf(
      A2ARemoteCallError,
    );
  });

  it("an AGBoss peer's mesh limit is the same limit error", () => {
    const entry = { application: "b-application", start: "b-workflow-start" };
    const chain = [{ application: "a-application", start: "a-workflow-start", executionId: "e" }];
    const loop = { [MESH]: { code: "limit.mesh-loop", details: { entry, chain } } };
    const hops = { [MESH]: { code: "limit.hops", details: { entry, chain, maxMeshHops: 1 } } };

    expect(failureOf(taskIn(TaskState.TASK_STATE_REJECTED, loop), "a")).toBeInstanceOf(
      MeshLoopDetectedError,
    );
    expect(failureOf(taskIn(TaskState.TASK_STATE_FAILED, hops), "a")).toBeInstanceOf(
      HopsLimitExceededError,
    );
  });

  it("a remote code is read only when it is one", () => {
    expect(remoteCodeOf("limit.hops")).toBe("limit.hops");
    expect(remoteCodeOf("internal")).toBe("internal");
    expect(remoteCodeOf("a".repeat(100))).toBe("a".repeat(100));
    expect(remoteCodeOf("a".repeat(101))).toBeUndefined();
    expect(remoteCodeOf("Limit.Hops")).toBeUndefined();
    expect(remoteCodeOf("limit hops")).toBeUndefined();
    expect(remoteCodeOf("limit.")).toBeUndefined();
    expect(remoteCodeOf("x\nlimit.hops")).toBeUndefined();
    expect(remoteCodeOf(7)).toBeUndefined();
  });
});

describe("reconciling a pending accept, by peer", () => {
  const agboss: A2ARemotePeer = {
    kind: A2APeerKind.AGBoss,
    idempotencyRetention: hours(24),
    mesh: true,
  };
  const foreign: A2ARemotePeer = {
    kind: A2APeerKind.Foreign,
    idempotencyRetention: undefined,
    mesh: false,
  };
  const callOf = (
    peer: A2ARemotePeer,
    taskId: string | undefined,
    getTask: AcceptCall["client"]["getTask"] = () => Promise.reject(new Error("not asked")),
  ): AcceptCall => ({
    agent: "billing-a2a-agent",
    url: "https://billing.example",
    peer,
    client: { sendMessage: () => Promise.reject(new Error("not sent")), getTask },
    clock: { now: () => new Date(0), sleep: () => Promise.resolve() },
    parts: [],
    skill: undefined,
    contextId: undefined,
    taskId,
    key: undefined,
    sign: () => ({ metadata: {}, serviceParameters: {} }),
    signal: undefined,
  });
  const storedFor = (peer: A2ARemotePeer, taskId?: string) => ({
    storedRequest: JSON.stringify({ ...acceptRequestOf(callOf(peer, taskId)) }),
  });
  const storedPeerOnly = (peer: A2ARemotePeer) => ({
    storedRequest: JSON.stringify({
      peer: { kind: peer.kind, idempotencyRetention: peer.idempotencyRetention ?? null },
    }),
  });
  const withHistory = (...messageIds: string[]): Task => ({
    ...taskIn(TaskState.TASK_STATE_WORKING),
    history: messageIds.map((messageId) => ({
      messageId,
      contextId: "c-1",
      taskId: "t-1",
      role: 1,
      parts: [],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    })),
  });

  it("an AGBoss peer's notSent is trusted within its retention (KeyReplay)", async () => {
    expect(notSentOf(agboss)).toEqual({ trust: NotSentTrust.KeyReplay, keyRetention: hours(24) });
    expect(notSentOf(foreign)).toEqual({ trust: NotSentTrust.Lookup });
    expect(
      (await reconciliationOf(callOf(agboss, undefined), storedFor(agboss), "m-1")).verdict,
    ).toBe(OutboundCallVerdict.NotSent);
  });

  it("a peer whose trust changed since the call was recorded is unknown: never resent", async () => {
    const changed = await reconciliationOf(callOf(agboss, undefined), storedFor(foreign), "m-1");
    const longer = await reconciliationOf(
      callOf({ ...agboss, idempotencyRetention: hours(48) }, undefined),
      storedFor(agboss),
      "m-1",
    );
    const none = await reconciliationOf(callOf(agboss, undefined), { storedRequest: "{}" }, "m-1");
    const peerOnly = await reconciliationOf(
      callOf(agboss, undefined),
      storedPeerOnly(agboss),
      "m-1",
    );
    const otherUrl = await reconciliationOf(
      { ...callOf(agboss, undefined), url: "https://billing-v2.example" },
      storedFor(agboss),
      "m-1",
    );
    const otherSkill = await reconciliationOf(
      { ...callOf(agboss, undefined), skill: "refund-workflow-start" },
      storedFor(agboss),
      "m-1",
    );
    const otherTask = await reconciliationOf(
      callOf(agboss, "t-9"),
      storedFor(agboss, "t-1"),
      "m-1",
    );
    const otherAgent = await reconciliationOf(
      { ...callOf(agboss, undefined), agent: "other-a2a-agent" },
      storedFor(agboss),
      "m-1",
    );
    const sameParts = await reconciliationOf(
      { ...callOf(agboss, undefined), parts: [dataPartOf({ masked: "<email>" })] },
      storedFor(agboss),
      "m-1",
    );

    expect(sameParts.verdict).toBe(OutboundCallVerdict.NotSent); // the parts are masked as stored
    for (const verdict of [
      changed,
      longer,
      none,
      peerOnly,
      otherUrl,
      otherSkill,
      otherTask,
      otherAgent,
    ]) {
      expect(verdict.verdict).toBe(OutboundCallVerdict.Unknown);
      expect(fieldOf(verdict, "reason")).toMatch(/agent changed since the call was recorded/u);
    }
    await expect(
      reconciliationOf(callOf(agboss, undefined), { storedRequest: "[redacted]" }, "m"),
    ).rejects.toThrow();
  });

  it("a foreign peer's new message is unknown: never sent again", async () => {
    const verdict = await reconciliationOf(callOf(foreign, undefined), storedFor(foreign), "m-1");
    expect(verdict.verdict).toBe(OutboundCallVerdict.Unknown);
    expect(fieldOf(verdict, "reason")).toMatch(
      /^foreign A2A peer: it declares no messageId deduplication/u,
    );
  });

  it("a foreign peer's reply: completed only when the task's history holds its messageId", async () => {
    const asked: unknown[] = [];
    const answering =
      (task: Task): AcceptCall["client"]["getTask"] =>
      (...args) => {
        asked.push(args);
        return Promise.resolve(task);
      };

    const arrived = await reconciliationOf(
      callOf(foreign, "t-1", answering(withHistory("m-0", "m-1"))),
      storedFor(foreign, "t-1"),
      "m-1",
    );
    const missing = await reconciliationOf(
      callOf(foreign, "t-1", answering(withHistory("m-0"))),
      storedFor(foreign, "t-1"),
      "m-1",
    );

    expect(arrived.verdict).toBe(OutboundCallVerdict.Completed);
    expect(fieldOf(arrived, "result")).toEqual({
      kind: "task",
      mesh: false,
      taskId: "t-1",
      contextId: "c-1",
    });
    expect(asked[0]).toStrictEqual([{ tenant: "", id: "t-1", historyLength: 100 }, {}]);
    expect(missing.verdict).toBe(OutboundCallVerdict.Unknown);
    expect(fieldOf(missing, "reason")).toMatch(
      /^foreign A2A peer: the task's history does not show the reply/u,
    );
    const signal = new AbortController().signal;
    await reconciliationOf(
      { ...callOf(foreign, "t-1", answering(withHistory())), signal },
      storedFor(foreign, "t-1"),
      "m-1",
    );
    expect(asked[2]).toStrictEqual([{ tenant: "", id: "t-1", historyLength: 100 }, { signal }]);
  });

  it("a reply's reconcile keeps its own context, else the task's when it reads as an id", async () => {
    const task = { ...withHistory("m-1"), contextId: "bad context!" };
    const own = await reconciliationOf(
      { ...callOf(foreign, "t-1", () => Promise.resolve(task)), contextId: "c-own" },
      storedFor(foreign, "t-1"),
      "m-1",
    );
    const unsafe = await reconciliationOf(
      callOf(foreign, "t-1", () => Promise.resolve(task)),
      storedFor(foreign, "t-1"),
      "m-1",
    );

    expect(fieldOf(own, "result")).toMatchObject({ contextId: "c-own" });
    expect(fieldOf(unsafe, "result")).toMatchObject({ contextId: "" });
  });

  it("a failed read is thrown — OutboundCalls keeps it as the cause", async () => {
    const down = new Error("down");
    await expect(
      reconciliationOf(
        callOf(foreign, "t-1", () => Promise.reject(down)),
        storedFor(foreign, "t-1"),
        "m",
      ),
    ).rejects.toMatchObject({ name: "A2AProtocolError", operation: "GetTask" });
  });

  it("the call's name: one per client, kind and key", () => {
    expect(callNameOf(callOf(foreign, undefined))).toBe("a2a.billing-a2a-agent");
    expect(callNameOf(callOf(foreign, "t-1"))).toBe("a2a.billing-a2a-agent.reply");
    expect(callNameOf({ ...callOf(foreign, "t-1"), key: "second" })).toBe(
      "a2a.billing-a2a-agent.reply.second",
    );
  });
});

describe("the transport's edges", () => {
  const policy = originPolicyOf("a", "https://agent.example/a2a");
  const once =
    (response: Response): typeof fetch =>
    () =>
      Promise.resolve(response);
  const fetchOf = (response: Response) =>
    wireFetchOf(once(response), () => Promise.resolve({}), policy);

  it("A2ANetworkError says the request got no answer and keeps its cause", () => {
    const cause = new TypeError("reset");
    const error = new A2ANetworkError(cause);
    expect(error).toMatchObject({
      name: "A2ANetworkError",
      message: "the A2A request got no answer (network)",
      cause,
    });
  });

  it("a body that is JSON but no object is no JSON-RPC answer and no refusal", async () => {
    await expect(
      fetchOf(Response.json("text", { status: 500 }))("https://agent.example/a2a"),
    ).rejects.toThrow(/HTTP 500/);
    await expect(
      fetchOf(Response.json(null, { status: 401 }))("https://agent.example/a2a"),
    ).rejects.toThrow(/HTTP 401/);
    await expect(
      fetchOf(Response.json(null, { status: 500 }))("https://agent.example/a2a"),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("a refusal's code is the whole of an a2a.caller-* code; its text is fixed", async () => {
    const refusal = (code: string) =>
      fetchOf(Response.json({ code }, { status: 401 }))("https://agent.example/a2a").catch(
        (error: unknown) => error,
      );

    expect(await refusal("x.a2a.caller-forbidden")).toBeInstanceOf(HttpStatusError);
    expect(await refusal("a2a.caller-forbidden!")).toBeInstanceOf(HttpStatusError);
    expect(await refusal("a2a.caller-")).toBeInstanceOf(HttpStatusError);
    expect(await refusal("a2a.caller-forbidden")).toMatchObject({
      message: expect.stringContaining("refused by the agent's caller resolver"),
    });
  });

  it("a URL or a Request is read for its origin", async () => {
    const seen: string[] = [];
    const fetcher = wireFetchOf(
      (input) => {
        seen.push(urlOf(input));
        return Promise.resolve(Response.json({}));
      },
      () => Promise.resolve({}),
      policy,
    );

    await fetcher(new URL("https://agent.example/a"));
    await fetcher(new Request("https://agent.example/b"));
    await expect(fetcher(new Request("https://evil.example/c"))).rejects.toBeInstanceOf(
      A2AOriginError,
    );
    expect(seen).toEqual(["https://agent.example/a", "https://agent.example/b"]);
  });

  it("a redirect is any 3xx, or an opaque one; a 400 is none", async () => {
    const opaque = Object.defineProperties(new Response(null, { status: 200 }), {
      type: { value: "opaqueredirect" },
      status: { value: 0 },
      ok: { value: false },
    });
    const at = (status: number) =>
      new Response(null, { status, headers: { location: "https://evil.example/" } });

    await expect(fetchOf(opaque)("https://agent.example/card.json")).rejects.toThrow(/HTTP 0/);
    await expect(fetchOf(at(300))("https://agent.example/card.json")).rejects.toMatchObject({
      site: A2AOriginSite.Redirect,
    });
    await expect(fetchOf(at(399))("https://agent.example/card.json")).rejects.toMatchObject({
      site: A2AOriginSite.Redirect,
    });
    await expect(fetchOf(at(400))("https://agent.example/card.json")).rejects.toThrow(/HTTP 400/);
  });

  it("a network failure with options but no signal is A2ANetworkError", async () => {
    const failing: typeof fetch = () => Promise.reject(new TypeError("down"));
    await expect(
      wireFetchOf(
        failing,
        () => Promise.resolve({}),
        policy,
      )("https://agent.example/a2a", { method: "POST" }),
    ).rejects.toBeInstanceOf(A2ANetworkError);
  });

  it("a data: or relative URL has no origin", () => {
    expect(() => originPolicyOf("a", "data:text/plain,x")).toThrow(/\[a2a\.url-invalid\]/);
    expect(isAllowedOrigin(originPolicyOf("a", "https://b.example"), "data:text/plain,x")).toBe(
      false,
    );
  });

  it("a status or a REST error deeper in the causes is found, after the outer error", async () => {
    const thrown = await fetchOf(new Response("x", { status: 404 }))(
      "https://agent.example/a2a",
    ).catch((e: unknown) => e);
    const rest = new RestTaskNotFoundError({ statusCode: 410 });

    expect(
      wireErrorOf(new Error("outer", { cause: thrown }), "a", A2AClientOperation.GetTask),
    ).toMatchObject({ httpStatus: 404 });
    expect(
      wireErrorOf(new Error("outer", { cause: rest }), "a", A2AClientOperation.GetTask),
    ).toMatchObject({ httpStatus: 410 });
    expect(wireErrorOf(new Error("plain"), "agent-x", A2AClientOperation.CancelTask)).toMatchObject(
      {
        agent: "agent-x",
        operation: A2AClientOperation.CancelTask,
        httpStatus: undefined,
      },
    );
  });

  it("a cause chain is read MAX_CAUSES deep, no deeper", () => {
    const network = new A2ANetworkError(new TypeError("x"));
    const wrapped = (depth: number): Error => {
      let error: Error = network;
      for (let index = 1; index < depth; index += 1)
        error = new Error(`layer ${String(index)}`, { cause: error });
      return error;
    };
    expect(wireErrorOf(wrapped(MAX_CAUSES), "a", A2AClientOperation.GetTask)).toBe(network);
    expect(wireErrorOf(wrapped(MAX_CAUSES + 1), "a", A2AClientOperation.GetTask)).not.toBe(network);
  });

  it("only an A2AProtocolError's codes count as definite: a plain error with one does not", () => {
    const lookalike = Object.assign(new Error("x"), { rpcCode: -32602, httpStatus: 400 });
    expect(isDefiniteSendFailure(lookalike)).toBe(false);
  });

  it("the SDK client is built on the client's fetch for both bindings", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = (input) => {
      seen.push(urlOf(input));
      return Promise.resolve(new Response("gone", { status: 404 }));
    };
    const card = {
      name: "rest",
      description: "",
      supportedInterfaces: [
        {
          url: "https://agent.example/rest",
          protocolBinding: "HTTP+JSON",
          tenant: "",
          protocolVersion: "1.0",
        },
      ],
      provider: undefined,
      version: "1",
      capabilities: { streaming: false, pushNotifications: false, extensions: [] },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: [],
      defaultOutputModes: [],
      skills: [],
      signatures: [],
    };
    const client = await sdkClientOf(
      card,
      wireFetchOf(fetcher, () => Promise.resolve({}), policy),
    );

    const got = await client.getTask({ tenant: "", id: "t-1" }).catch((error: unknown) => error);

    expect(seen[0]).toMatch(/^https:\/\/agent\.example\/rest/u);
    expect(wireErrorOf(got, "a", A2AClientOperation.GetTask)).toMatchObject({ httpStatus: 404 });
  });
});

describe("the outcome's edges", () => {
  it("a task without a status, or a FAILED one whose mesh entry is null, a string or has no code", () => {
    expect(
      failureOf({ ...taskIn(TaskState.TASK_STATE_FAILED), status: undefined }, "a"),
    ).toMatchObject({
      name: "A2ARemoteCallError",
      agent: "a",
      reason: "malformed-answer",
      taskId: "t-1",
    });
    for (const entry of [null, "x", {}, { code: 7 }]) {
      expect(failureOf(taskIn(TaskState.TASK_STATE_FAILED, { [MESH]: entry }), "a")).toMatchObject({
        name: "A2ATaskFailedError",
        remoteCode: undefined,
      });
    }
    expect(failureOf(taskIn(TaskState.TASK_STATE_UNSPECIFIED), "a")).toMatchObject({
      agent: "a",
      taskId: "t-1",
    });
  });
});
