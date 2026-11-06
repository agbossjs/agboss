/**
 * #809 — the accept round trip piece by piece (the `a2a-client` mutation shard): the message and
 * request it sends, what it stores of the answer, its resends of unknown outcome by peer, and how it
 * drives `OutboundCalls` (a fake here: the protocol itself has its own suites).
 */
import { Message, Role, TaskState, type SendMessageRequest, type Task } from "@a2a-js/sdk";
import type { RequestOptions } from "@a2a-js/sdk/client";
import { describe, expect, it } from "vitest";
import { A2AAgent, A2AClient } from "../../../src/a2a/index.js";
import { Tool, type ToolHandler } from "../../../src/index.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { testTool } from "../../../src/testing/index.js";
import { AGENT_URL, scripts, SdkAgent } from "./support/sdk-agent.js";

class PlainReplyDto {
  @Text()
  text!: string;
}
import {
  accept,
  acceptedDirectly,
  acceptedThrough,
  claimCallName,
  MAX_ACCEPT_ATTEMPTS,
  type AcceptRuntime,
} from "../../../src/a2a/client/a2a-accept.js";
import {
  acceptedOf,
  messageIdOf,
  sentOf,
  type AcceptCall,
  type AcceptResult,
} from "../../../src/a2a/client/a2a-message.js";
import { acceptRequestOf, type AcceptRequest } from "../../../src/a2a/client/a2a-reconcile.js";
import { A2APeerKind, type A2ARemotePeer } from "../../../src/a2a/client/a2a-card.js";
import {
  A2AContractError,
  A2AContractRule,
  A2AProtocolError,
  A2AClientOperation,
} from "../../../src/a2a/client/a2a-client-errors.js";
import { A2ANetworkError } from "../../../src/a2a/client/a2a-transport.js";
import { isDefiniteSendFailure } from "../../../src/a2a/client/a2a-wire-errors.js";
import { NotSentTrust } from "../../../src/app/outbound-call-contract.js";
import {
  OutboundCallSendStatus,
  type OutboundCall,
  type OutboundCallOutcome,
  type OutboundCallSendOptions,
} from "../../../src/app/outbound-calls.js";
import type { EffectKey } from "../../../src/infrastructure/fenced-effect.repository.js";
import { hours, type Milliseconds } from "../../../src/units/index.js";
import { effectKeyForTesting } from "../../../src/testing/contracts/effect-key.js";

const SKILLS = "https://agboss.dev/a2a/skills/v1";
const MESH = "https://agboss.dev/a2a/mesh/v1";
const AGBOSS: A2ARemotePeer = {
  kind: A2APeerKind.AGBoss,
  idempotencyRetention: hours(24),
  mesh: true,
};
const FOREIGN: A2ARemotePeer = {
  kind: A2APeerKind.Foreign,
  idempotencyRetention: undefined,
  mesh: false,
};

const taskOf = (id = "t-1", contextId = "c-1"): Task => ({
  id,
  contextId,
  status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: undefined },
  artifacts: [],
  history: [],
  metadata: undefined,
});

const messageAnswer: Message = {
  messageId: "answer-1",
  contextId: "c-9",
  taskId: "",
  role: Role.ROLE_AGENT,
  parts: [
    {
      content: { $case: "text", value: "hi" },
      metadata: undefined,
      filename: "",
      mediaType: "text/plain",
    },
  ],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
};

/** A client whose `sendMessage` answers in turn; what it was sent. */
function clientAnswering(...answers: (Task | Message | Error)[]) {
  const sent: {
    readonly params: SendMessageRequest;
    readonly options: RequestOptions | undefined;
  }[] = [];
  const client: AcceptCall["client"] = {
    sendMessage: (params: SendMessageRequest, options?: RequestOptions) => {
      sent.push({ params, options });
      const next = answers.shift() ?? new Error("no more answers");
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    getTask: () => Promise.reject(new Error("not asked")),
  };
  return { client, sent };
}

/** A clock whose sleeps end at once, each one recorded; `onSleep` runs during it. */
function clockRecording(onSleep: () => void = () => undefined) {
  const slept: number[] = [];
  const clock: AcceptCall["clock"] = {
    now: () => new Date(0),
    sleep: (delay: Milliseconds) => {
      slept.push(delay);
      onSleep();
      return Promise.resolve();
    },
  };
  return { clock, slept };
}

const textPart = {
  content: { $case: "text" as const, value: "where is #7?" },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
};

function callOf(changes: Partial<AcceptCall> = {}): AcceptCall {
  return {
    agent: "desk-a2a-agent",
    url: "http://agent.test/a2a",
    peer: FOREIGN,
    client: clientAnswering(taskOf()).client,
    clock: clockRecording().clock,
    parts: [textPart],
    skill: undefined,
    contextId: undefined,
    taskId: undefined,
    key: undefined,
    sign: () => ({ metadata: {}, serviceParameters: {} }),
    signal: undefined,
    ...changes,
  };
}

const network = () =>
  new A2AProtocolError({ agent: "a", operation: A2AClientOperation.SendMessage, httpStatus: 503 });

describe("the message and the request one SendMessage sends", () => {
  it("returnImmediately, the call's ids or empty, a copy of its parts, no metadata without a skill", async () => {
    const { client, sent } = clientAnswering(taskOf());
    const parts = [textPart];

    await sentOf(callOf({ client, parts }), "m-1");

    expect(sent[0]?.params).toEqual({
      tenant: "",
      message: {
        messageId: "m-1",
        contextId: "",
        taskId: "",
        role: Role.ROLE_USER,
        parts: [textPart],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: [],
        taskPushNotificationConfig: undefined,
        returnImmediately: true,
      },
      metadata: undefined,
    });
    expect(sent[0]?.params.message?.parts).not.toBe(parts);
    expect(sent[0]?.options).toStrictEqual({ serviceParameters: {} });
  });

  it("the skill, the context, the task, what the mesh signs and the signal", async () => {
    const { client, sent } = clientAnswering(taskOf());
    const signal = new AbortController().signal;
    const signed: Message[] = [];
    const sign = (message: Message) => {
      signed.push(message);
      return {
        metadata: { [MESH]: { envelope: "e" } },
        serviceParameters: { traceparent: "00-x" },
      };
    };

    await sentOf(
      callOf({ client, skill: "ask", contextId: "c-1", taskId: "t-1", sign, signal }),
      "m-2",
    );

    expect(signed[0]?.metadata).toEqual({ [SKILLS]: { skill: "ask" } }); // signed before the mesh entry
    expect(sent[0]?.params.message).toMatchObject({
      contextId: "c-1",
      taskId: "t-1",
      metadata: { [SKILLS]: { skill: "ask" }, [MESH]: { envelope: "e" } },
    });
    expect(sent[0]?.options).toEqual({ serviceParameters: { traceparent: "00-x" }, signal });
  });

  it("stores a task's ids, or a message's wire JSON, with when it was accepted", async () => {
    const task = await sentOf(
      callOf({ client: clientAnswering(taskOf("t-7", "c-7")).client }),
      "m",
    );
    const message = await sentOf(callOf({ client: clientAnswering(messageAnswer).client }), "m");

    const acceptedAt = new Date(0).toISOString();
    expect(task.result).toEqual({
      kind: "task",
      taskId: "t-7",
      contextId: "c-7",
      mesh: false,
      acceptedAt,
    });
    expect(message.result).toEqual({
      kind: "message",
      message: JSON.stringify(Message.toJSON(messageAnswer)),
      mesh: false,
      acceptedAt,
    });
    expect(message.answer).toBe(messageAnswer);
  });

  it("#810: meshed only when the envelope rode and the agent echoed the extension; its bodyHash kept", async () => {
    const sign = () => ({
      metadata: { [MESH]: { envelope: "e" } },
      serviceParameters: {},
      bodyHash: "sha256:b",
    });
    const sent = (meshEchoOf?: () => boolean | undefined) =>
      sentOf(
        callOf({
          client: clientAnswering(taskOf()).client,
          sign,
          ...(meshEchoOf === undefined ? {} : { meshEchoOf }),
        }),
        "m",
      );

    expect((await sent(() => true)).result).toMatchObject({ mesh: true, bodyHash: "sha256:b" });
    const unechoed = (await sent(() => false)).result;
    expect(unechoed).toMatchObject({ mesh: false });
    expect(unechoed).not.toHaveProperty("bodyHash");
    expect((await sent()).result).toMatchObject({ mesh: false });
  });

  it("a failure is translated: codes only, the signal's reason when it ended the call", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    controller.abort(reason);
    const raw = new Error("connection reset by bob@example.com");

    await expect(
      sentOf(callOf({ client: clientAnswering(raw).client }), "m"),
    ).rejects.toMatchObject({
      name: "A2AProtocolError",
      operation: A2AClientOperation.SendMessage,
      agent: "desk-a2a-agent",
    });
    await expect(
      sentOf(callOf({ client: clientAnswering(raw).client, signal: controller.signal }), "m"),
    ).rejects.toBe(reason);
  });

  it("what the intent stores of the request: the parts as wire JSON, nulls for what is not set", () => {
    expect(acceptRequestOf(callOf())).toEqual({
      agent: "desk-a2a-agent",
      url: "http://agent.test/a2a",
      skill: null,
      contextId: null,
      taskId: null,
      parts: JSON.stringify([{ text: "where is #7?", mediaType: "text/plain" }]),
      peer: { kind: A2APeerKind.Foreign, idempotencyRetention: null },
    });
    expect(acceptRequestOf(callOf({ peer: AGBOSS })).peer).toEqual({
      kind: A2APeerKind.AGBoss,
      idempotencyRetention: hours(24),
    });
    expect(acceptRequestOf(callOf({ skill: "s", contextId: "c", taskId: "t" }))).toMatchObject({
      skill: "s",
      contextId: "c",
      taskId: "t",
    });
  });
});

describe("what an accepted answer is", () => {
  it("a message: the answer itself, or the stored one read back", () => {
    const stored = {
      kind: "message" as const,
      mesh: true,
      message: JSON.stringify(Message.toJSON(messageAnswer)),
    };

    const live = acceptedOf(stored, messageAnswer, true, "m-1");
    const replayed = acceptedOf(stored, undefined, false, "m-1");
    const fromTask = acceptedOf(stored, taskOf(), false, "m-1");

    expect(live).toEqual({
      taskId: undefined,
      contextId: "c-9",
      task: undefined,
      message: messageAnswer,
      isNew: true,
      messageId: "m-1",
      isMeshed: true,
    });
    expect(live.message).toBe(messageAnswer);
    expect(replayed.message).toEqual(messageAnswer);
    expect(replayed.isNew).toBe(false);
    expect(fromTask.message).toEqual(messageAnswer);
  });

  it("a task: its ids, the task when this call got it", () => {
    const stored = { kind: "task" as const, taskId: "t-1", contextId: "c-1", mesh: false };
    const task = taskOf();

    expect(acceptedOf(stored, task, true, "m")).toEqual({
      taskId: "t-1",
      contextId: "c-1",
      task,
      message: undefined,
      isNew: true,
      messageId: "m",
      isMeshed: false,
    });
    expect(acceptedOf(stored, undefined, false, "m").task).toBeUndefined();
    expect(acceptedOf(stored, messageAnswer, false, "m").task).toBeUndefined();
  });
});

describe("outside an execution: sent directly", () => {
  it("an AGBoss peer is sent again with the same messageId, waiting longer each time", async () => {
    const { client, sent } = clientAnswering(
      network(),
      new A2ANetworkError(new TypeError("x")),
      taskOf(),
    );
    const { clock, slept } = clockRecording();

    const accepted = await acceptedDirectly(callOf({ client, clock, peer: AGBOSS }));

    expect(sent).toHaveLength(3);
    expect(new Set(sent.map(({ params }) => params.message?.messageId)).size).toBe(1);
    expect(accepted.messageId).toBe(sent[0]?.params.message?.messageId);
    expect(accepted.messageId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(accepted).toMatchObject({ taskId: "t-1", isNew: true });
    expect(slept).toEqual([250, 500]);
  });

  it("at most MAX_ACCEPT_ATTEMPTS sends, then the last error", async () => {
    const errors = [network(), network(), network(), network()];
    const { client, sent } = clientAnswering(...errors);

    await expect(acceptedDirectly(callOf({ client, peer: AGBOSS }))).rejects.toBe(errors[2]);
    expect(sent).toHaveLength(MAX_ACCEPT_ATTEMPTS);
  });

  it("a definite failure is never sent again; a foreign peer never sent again at all", async () => {
    const definite = new A2AProtocolError({
      agent: "a",
      operation: A2AClientOperation.SendMessage,
      rpcCode: -32602,
    });
    const agboss = clientAnswering(definite, taskOf());
    const foreign = clientAnswering(network(), taskOf());

    await expect(acceptedDirectly(callOf({ client: agboss.client, peer: AGBOSS }))).rejects.toBe(
      definite,
    );
    await expect(acceptedDirectly(callOf({ client: foreign.client }))).rejects.toBeInstanceOf(
      A2AProtocolError,
    );
    expect([agboss.sent.length, foreign.sent.length]).toEqual([1, 1]);
  });

  it("a signal that aborts during the wait ends the call with its reason, nothing sent again", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const { client, sent } = clientAnswering(network(), taskOf());
    const { clock } = clockRecording(() => {
      controller.abort(reason);
    });

    await expect(
      acceptedDirectly(callOf({ client, clock, peer: AGBOSS, signal: controller.signal })),
    ).rejects.toBe(reason);
    expect(sent).toHaveLength(1);
  });
});

/** A fake `OutboundCalls`: each `send` gives the next scripted outcome, or runs the call's `send`. */
function outboundCallsScripted(...steps: ("send" | OutboundCallSendStatus | Error)[]) {
  const seen: {
    readonly key: EffectKey;
    readonly options: OutboundCallSendOptions<AcceptRequest, AcceptResult>;
  }[] = [];
  const replayed: AcceptResult = {
    kind: "task",
    taskId: "t-replayed",
    contextId: "c-replayed",
    mesh: true,
  };
  const outboundCalls: AcceptRuntime["outboundCalls"] = {
    send: async (key, options) => {
      seen.push({ key, options });
      const step = steps.shift() ?? "send";
      if (step instanceof Error) throw step;
      const call: OutboundCall<AcceptRequest> = {
        idempotencyKey: `key-${key.name}`,
        request: options.request,
        attempt: 1,
        target: options.target,
        operation: options.operation,
        signal: new AbortController().signal,
      };
      const result = step === "send" ? await options.send(call) : replayed;
      const status = step === "send" ? OutboundCallSendStatus.Sent : step;
      const outcome: OutboundCallOutcome<AcceptResult> = {
        status,
        result,
        attempt: 1,
        idempotencyKey: `key-${key.name}`,
      };
      return outcome;
    },
  };
  return { outboundCalls, seen };
}

const runtimeOf = (
  outboundCalls: AcceptRuntime["outboundCalls"],
  frame: object = {},
): AcceptRuntime => ({
  outboundCalls,
  keyOf: (name): EffectKey =>
    effectKeyForTesting({
      scopeKey: "acme:root-1",
      tenantId: "acme",
      leaseExecutionId: "root-1",
      token: 1,
      idempotencyKey: "root-1:step:1",
      name,
    }),
  tenantId: "acme",
  frame,
});

describe("inside an execution: through OutboundCalls", () => {
  it("one call named by the client, its request, its hooks and its trust", async () => {
    const { outboundCalls, seen } = outboundCallsScripted("send");
    const { client, sent } = clientAnswering(taskOf());

    const accepted = await acceptedThrough(
      callOf({ client, peer: AGBOSS }),
      runtimeOf(outboundCalls),
    );

    expect(seen[0]?.key.name).toBe("a2a.desk-a2a-agent");
    expect(seen[0]?.options).toMatchObject({
      target: "desk-a2a-agent",
      operation: "SendMessage",
      request: acceptRequestOf(callOf({ peer: AGBOSS })),
      notSent: { trust: NotSentTrust.KeyReplay, keyRetention: hours(24) },
    });
    expect(seen[0]?.options.isDefiniteFailure).toBe(isDefiniteSendFailure);
    expect(sent[0]?.params.message?.messageId).toBe(messageIdOf("acme", "key-a2a.desk-a2a-agent"));
    expect(accepted).toMatchObject({
      taskId: "t-1",
      isNew: true,
      messageId: messageIdOf("acme", "key-a2a.desk-a2a-agent"),
    });
    expect(accepted.task).toEqual(taskOf());
  });

  it("a reply is its own call; reconcile asks the agent through the call", async () => {
    const { outboundCalls, seen } = outboundCallsScripted("send");
    const reply = { ...messageAnswer, messageId: messageIdOf("acme", "key-pending") };
    const getTask = () => Promise.resolve({ ...taskOf(), history: [reply] });
    const client: AcceptCall["client"] = { ...clientAnswering(taskOf()).client, getTask };
    const call = callOf({ client, taskId: "t-1" });

    await acceptedThrough(call, runtimeOf(outboundCalls));

    expect(seen[0]?.options).toMatchObject({
      operation: "SendMessage (reply)",
      notSent: { trust: NotSentTrust.Lookup },
    });
    expect(seen[0]?.key.name).toBe("a2a.desk-a2a-agent.reply");
    const lookup = {
      idempotencyKey: "key-pending",
      storedRequest: JSON.stringify(acceptRequestOf(call)),
      attempt: 1,
      attemptStartedAt: undefined,
      keyAge: undefined,
      target: "desk-a2a-agent",
      operation: "SendMessage (reply)",
      signal: new AbortController().signal,
    };
    await expect(Promise.resolve(seen[0]?.options.reconcile(lookup))).resolves.toMatchObject({
      verdict: "completed",
    });
  });

  it("sent or reconciled is new; replayed or joined is not", async () => {
    for (const [status, isNew] of [
      [OutboundCallSendStatus.Reconciled, true],
      [OutboundCallSendStatus.Replayed, false],
      [OutboundCallSendStatus.Joined, false],
    ] as const) {
      const { outboundCalls } = outboundCallsScripted(status);
      const accepted = await acceptedThrough(callOf(), runtimeOf(outboundCalls));
      expect([accepted.isNew, accepted.taskId, accepted.task]).toEqual([
        isNew,
        "t-replayed",
        undefined,
      ]);
    }
  });

  it("an ambiguous send is asked again: twice more for an AGBoss peer, once for a foreign one", async () => {
    const agboss = outboundCallsScripted(network(), network(), network(), "send");
    const foreign = outboundCallsScripted(network(), network(), "send");
    const definite = outboundCallsScripted(new Error("OutboundCallUnreconciledError"), "send");

    await expect(
      acceptedThrough(callOf({ peer: AGBOSS }), runtimeOf(agboss.outboundCalls)),
    ).rejects.toBeInstanceOf(A2AProtocolError);
    await expect(
      acceptedThrough(callOf(), runtimeOf(foreign.outboundCalls)),
    ).rejects.toBeInstanceOf(A2AProtocolError);
    await expect(acceptedThrough(callOf(), runtimeOf(definite.outboundCalls))).rejects.toThrow(
      "OutboundCallUnreconciledError",
    );
    expect([agboss.seen.length, foreign.seen.length, definite.seen.length]).toEqual([3, 2, 1]);
    expect(agboss.seen.map(({ key }) => key.name)).toEqual(Array(3).fill("a2a.desk-a2a-agent"));
  });

  it("a step's second call with another message needs its own key; the same one again is a retry", async () => {
    const frame = {};
    const { outboundCalls } = outboundCallsScripted("send", "send", "send");
    const first = callOf({
      skill: "ask",
      client: clientAnswering(taskOf(), taskOf(), taskOf()).client,
    });

    await acceptedThrough(first, runtimeOf(outboundCalls, frame));
    await acceptedThrough(first, runtimeOf(outboundCalls, frame));
    const other = acceptedThrough({ ...first, parts: [] }, runtimeOf(outboundCalls, frame));
    const keyed = acceptedThrough(
      { ...first, parts: [], key: "second" },
      runtimeOf(outboundCalls, frame),
    );

    await expect(other).rejects.toBeInstanceOf(A2AContractError);
    await expect(other).rejects.toMatchObject({
      rule: A2AContractRule.RepeatedCall,
      skill: "ask",
      agent: "desk-a2a-agent",
    });
    await expect(keyed).resolves.toMatchObject({ taskId: "t-1" });
    expect(() => {
      claimCallName({}, "n", callOf(), acceptRequestOf(callOf()));
    }).not.toThrow();
    const noSkill = {};
    claimCallName(noSkill, "n", callOf(), acceptRequestOf(callOf()));
    expect(() => {
      claimCallName(noSkill, "n", callOf(), acceptRequestOf(callOf({ contextId: "x" })));
    }).toThrow(expect.objectContaining({ skill: "" }));
  });
});

describe("accept: which way a message goes", () => {
  it("in a frame of no composed application (a unit runner's): refused, nothing sent", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ data: { text: "ok" } }) });

    @A2AAgent({
      name: "unit-a2a-agent",
      url: AGENT_URL,
      input: WorkflowStartTextDto,
      output: PlainReplyDto,
    })
    class UnitA2AAgent extends A2AClient<WorkflowStartTextDto, PlainReplyDto> {
      constructor() {
        super({ fetcher: agent.fetcher });
      }
    }

    @Tool({
      name: "unit-ask-tool",
      description: "Asks the agent",
      input: WorkflowStartTextDto,
      output: PlainReplyDto,
      deps: [UnitA2AAgent],
    })
    class UnitAskTool implements ToolHandler<WorkflowStartTextDto, PlainReplyDto> {
      constructor(private readonly peer: UnitA2AAgent) {}

      run(input: WorkflowStartTextDto): Promise<PlainReplyDto> {
        return this.peer.execute(input);
      }
    }

    const run = testTool(UnitAskTool)({ text: "hi" });

    // a step of no application has no OutboundCalls to record into: refused, never sent unrecorded
    await expect(run).rejects.toThrow(/\[a2a\.outside-application\] unit-a2a-agent/u);
    expect(agent.count("SendMessage")).toBe(0);
  });
});
