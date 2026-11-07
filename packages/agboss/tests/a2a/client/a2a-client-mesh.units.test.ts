/**
 * #810 — the client's mesh facts one unit at a time: the echo of the extension (what the agent
 * activated), what an accept stores to charge the same on every pass, the charges' identity, and the
 * record of a call made without the mesh.
 */
import { describe, expect, it } from "vitest";
import { A2A_MESH_EXTENSION } from "../../../src/a2a/index.js";
import { observeEcho, type ExtensionEcho } from "../../../src/a2a/client/a2a-echo.js";
import {
  acceptedOf,
  sentOf,
  type AcceptCall,
  type Accepted,
} from "../../../src/a2a/client/a2a-message.js";
import { Role, TaskState, type Task } from "@a2a-js/sdk";
import {
  chargedOf,
  recordRefused,
  settledChargeOf,
  settledPeerOf,
} from "../../../src/a2a/client/a2a-charges.js";
import type { A2AMeshActivation } from "../../../src/a2a/client/a2a-mesh-seam.js";
import { A2APeerKind } from "../../../src/a2a/client/a2a-card.js";
import { currentFrame, runInFrame } from "../../../src/flow/context/frame.js";
import type { ToolCallRemote } from "../../../src/mesh/mesh-call.js";
import { hours } from "../../../src/units/index.js";

const URI = A2A_MESH_EXTENSION;
const sendBody = (messageId: unknown, method = "SendMessage") =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { message: { messageId } } });

/** What `observeEcho` says of one request and answer. */
function echoOf(asked: string | null, body: unknown, answered: string | null): ExtensionEcho[] {
  const heard: ExtensionEcho[] = [];
  const headers = new Headers(asked === null ? {} : { "a2a-extensions": asked });
  const response = new Response("{}", {
    headers: answered === null ? {} : { "a2a-extensions": answered },
  });
  observeEcho(URI, { headers, body }, response, (echo) => heard.push(echo));
  return heard;
}

describe("#810: the echo of the mesh extension", () => {
  it("a send that asked for it: echoed or not, by its messageId", () => {
    expect(echoOf(URI, sendBody("m-1"), URI)).toEqual([{ messageId: "m-1", isEchoed: true }]);
    expect(echoOf(URI, sendBody("m-1"), null)).toEqual([{ messageId: "m-1", isEchoed: false }]);
    expect(echoOf(URI, sendBody("m-1"), "https://other.example/ext")).toEqual([
      { messageId: "m-1", isEchoed: false },
    ]);
  });

  it("names among others, spaces around them", () => {
    const listed = `https://agboss.dev/a2a/skills/v1 , ${URI}`;
    expect(echoOf(listed, sendBody("m-2"), ` x ,${URI} `)).toEqual([
      { messageId: "m-2", isEchoed: true },
    ]);
  });

  it("nothing for a request that did not ask for it", () => {
    expect(echoOf(null, sendBody("m-1"), URI)).toEqual([]);
    expect(echoOf("https://agboss.dev/a2a/skills/v1", sendBody("m-1"), URI)).toEqual([]);
  });

  it("nothing for a body that is no send of a message", () => {
    expect(echoOf(URI, undefined, URI)).toEqual([]);
    expect(echoOf(URI, "not json", URI)).toEqual([]);
    expect(echoOf(URI, '"a text"', URI)).toEqual([]);
    expect(echoOf(URI, "5", URI)).toEqual([]);
    expect(echoOf(URI, "null", URI)).toEqual([]);
    expect(echoOf(URI, sendBody("m-1", "GetTask"), URI)).toEqual([]);
    expect(echoOf(URI, JSON.stringify({ method: "SendMessage", params: null }), URI)).toEqual([]);
    expect(
      echoOf(URI, JSON.stringify({ method: "SendMessage", params: { message: 3 } }), URI),
    ).toEqual([]);
    expect(echoOf(URI, sendBody(7), URI)).toEqual([]);
  });
});

describe("#810: what an accept stores to charge the same on every pass", () => {
  const task = { kind: "task", taskId: "t-1", contextId: "c-1", mesh: true } as const;

  it("its body hash and its time, as stored — a replay reads them", () => {
    const stored = { ...task, bodyHash: "sha256:b", acceptedAt: "2026-11-04T12:00:00.000Z" };
    expect(acceptedOf(stored, undefined, false, "m-1")).toStrictEqual({
      taskId: "t-1",
      contextId: "c-1",
      task: undefined,
      message: undefined,
      isNew: false,
      messageId: "m-1",
      isMeshed: true,
      isRefused: false,
      bodyHash: "sha256:b",
      acceptedAt: "2026-11-04T12:00:00.000Z",
    });
  });

  it("none stored (an accept of before, a reconciled reply): none read", () => {
    const accepted = acceptedOf({ ...task, mesh: false }, undefined, false, "m-1");
    expect(accepted).not.toHaveProperty("bodyHash");
    expect(accepted).not.toHaveProperty("acceptedAt");
  });

  it("#849: a task the agent refused at the accept, as stored — a replay knows it was refused", () => {
    expect(acceptedOf({ ...task, refused: true }, undefined, false, "m-1").isRefused).toBe(true);
    expect(acceptedOf(task, undefined, false, "m-1").isRefused).toBe(false);
    const message = { kind: "message", message: '{"messageId":"r-1"}', mesh: false } as const;
    expect(acceptedOf(message, undefined, false, "m-1").isRefused).toBe(false);
  });
});

describe("#849: only an AGBoss agent's mesh limit at the accept is a refusal", () => {
  const NOW = new Date("2026-11-04T12:00:00.000Z");
  const limit = {
    code: "limit.hops",
    details: {
      entry: { application: "peer-application", start: "ask-workflow-start" },
      chain: [
        { application: "caller-application", start: "caller-workflow-start", executionId: "e-1" },
      ],
      maxMeshHops: 1,
    },
  };
  const rejected = (metadata: unknown): Task => ({
    id: "t-1",
    contextId: "c-1",
    status: {
      state: TaskState.TASK_STATE_REJECTED,
      message: {
        messageId: "refusal",
        contextId: "c-1",
        taskId: "t-1",
        role: Role.ROLE_AGENT,
        parts: [],
        metadata: { [URI]: metadata },
        extensions: [],
        referenceTaskIds: [],
      },
      timestamp: NOW.toISOString(),
    },
    artifacts: [],
    history: [],
    metadata: undefined,
  });
  const callOf = (answer: Task, kind: A2APeerKind, isEchoed: boolean): AcceptCall => ({
    agent: "peer-a2a-agent",
    url: "http://peer.test/a2a",
    peer:
      kind === A2APeerKind.AGBoss
        ? { kind, idempotencyRetention: hours(1), mesh: true }
        : { kind, idempotencyRetention: undefined, mesh: false },
    client: {
      sendMessage: () => Promise.resolve(answer),
      getTask: () => Promise.reject(new Error("no read")),
    },
    clock: { now: () => NOW, sleep: () => Promise.resolve() },
    parts: [],
    skill: undefined,
    contextId: undefined,
    taskId: undefined,
    key: undefined,
    sign: () => ({ metadata: {}, serviceParameters: {}, bodyHash: "sha256:b" }),
    meshEchoOf: () => isEchoed,
    signal: undefined,
  });
  const refusedOf = async (answer: Task, kind: A2APeerKind, isEchoed = true) =>
    (await sentOf(callOf(answer, kind, isEchoed), "m-1")).result.refused;

  it("an AGBoss agent the mesh rode to, REJECTED with its limit: refused", async () => {
    expect(await refusedOf(rejected(limit), A2APeerKind.AGBoss)).toBe(true);
  });

  it("a foreign agent's REJECTED, an unmeshed call's, one with no mesh limit: charged as accepted", async () => {
    expect(await refusedOf(rejected(limit), A2APeerKind.Foreign)).toBeUndefined();
    expect(await refusedOf(rejected(limit), A2APeerKind.AGBoss, false)).toBeUndefined();
    expect(await refusedOf(rejected({ code: "internal" }), A2APeerKind.AGBoss)).toBeUndefined();
  });
});

describe("#810: the charges' identity and the record of an unmeshed call", () => {
  const NOW = new Date("2026-11-04T12:05:00.000Z");
  const clock = { now: () => NOW };
  const accepted = (fields: Partial<Accepted> = {}): Accepted => ({
    taskId: "t-1",
    contextId: "c-1",
    task: undefined,
    message: undefined,
    isNew: false,
    messageId: "m-1",
    isMeshed: false,
    isRefused: false,
    ...fields,
  });

  it("the stored accept's time, else now; the settle's own now", () => {
    const stored = "2026-11-04T12:00:00.000Z";
    expect(chargedOf(accepted({ acceptedAt: stored, bodyHash: "h" }), clock)).toEqual({
      messageId: "m-1",
      acceptedAt: stored,
      bodyHash: "h",
      taskId: "t-1",
      now: NOW,
    });
    expect(chargedOf(accepted(), clock).acceptedAt).toBe(NOW.toISOString());
    const later = new Date(NOW.getTime() + 1000);
    const settled = settledChargeOf(chargedOf(accepted(), clock), { now: () => later });
    expect(settled.now).toBe(later);
  });

  const activation = (mesh: boolean): A2AMeshActivation => ({
    peer: { kind: A2APeerKind.AGBoss, idempotencyRetention: hours(1), mesh },
    sign: () => ({ metadata: {}, serviceParameters: {} }),
    charge: () => undefined,
    settle: () => undefined,
  });

  /** Runs `settledPeerOf` in a tool call's frame (or one without mesh services); what it recorded. */
  async function recorded(
    run: () => unknown,
    withMeshCall = true,
  ): Promise<readonly ToolCallRemote[]> {
    const remotes: ToolCallRemote[] = [];
    const meshCall = {
      tool: "t",
      remainingBudget: () => undefined,
      deadlineAt: NOW,
      recordRemote: (remote: ToolCallRemote) => remotes.push(remote),
    };
    const spec = { execution: {}, step: {}, services: withMeshCall ? { meshCall } : {} } as never;
    await runInFrame(spec, () => Promise.resolve(run()));
    return remotes;
  }

  it("a task's call without the mesh is recorded mesh: false; with it, or a message, nothing", async () => {
    expect(
      await recorded(() => settledPeerOf(activation(true), accepted(), "peer-application")),
    ).toEqual([{ application: "peer-application", executionId: "t-1", mesh: false }]);
    expect(
      await recorded(() =>
        settledPeerOf(activation(true), accepted({ isMeshed: true }), "peer-application"),
      ),
    ).toEqual([]);
    expect(
      await recorded(() =>
        settledPeerOf(activation(false), accepted({ taskId: undefined }), "peer-application"),
      ),
    ).toEqual([]);
  });

  it("the peer as the call had it: meshed only when the activation could and the accept did", () => {
    expect(settledPeerOf(activation(true), accepted({ isMeshed: true }), "p").mesh).toBe(true);
    expect(settledPeerOf(activation(false), accepted({ isMeshed: true }), "p").mesh).toBe(false);
    expect(settledPeerOf(activation(true), accepted(), "p").mesh).toBe(false);
  });

  it("a frame of no tool call (an action's) or none at all: nothing recorded, nothing thrown", async () => {
    expect(await recorded(() => settledPeerOf(activation(false), accepted(), "p"), false)).toEqual(
      [],
    );
    expect(currentFrame()).toBeUndefined();
    expect(settledPeerOf(activation(false), accepted(), "p").mesh).toBe(false);
  });

  it("#849: a refused call is recorded refused: true — with mesh: false when the mesh did not ride", async () => {
    expect(
      await recorded(() => {
        recordRefused(activation(true), accepted({ isMeshed: true }), "peer-application");
      }),
    ).toEqual([{ application: "peer-application", executionId: "t-1", refused: true }]);
    expect(
      await recorded(() => {
        recordRefused(activation(false), accepted({ isMeshed: true }), "peer-application");
      }),
    ).toEqual([
      { application: "peer-application", executionId: "t-1", mesh: false, refused: true },
    ]);
    expect(
      await recorded(() => {
        recordRefused(activation(true), accepted({ taskId: undefined }), "peer-application");
      }),
    ).toEqual([]);
  });
});
