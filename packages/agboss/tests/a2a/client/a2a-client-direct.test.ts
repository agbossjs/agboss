/**
 * #860 AC2: the client of a direct-reply skill — a `Message` answer needs no task to wait for (no
 * `GetTask`, no subscription), its output read from the message's parts; an AGBoss skill whose card
 * says `reply: "message"` is trusted for a resend of its messageId only within the card's
 * `messageIdempotencyRetention` (default 15 min), never the tasks' 24 h — the `keyRetention`
 * `OutboundCalls` fails closed past (`OutboundCallUnreconciledError`, #795); against AGBoss itself
 * the typed and untyped calls get the reply.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCard } from "@a2a-js/sdk";
import { A2AClient } from "../../../src/a2a/client/a2a-client.js";
import { A2APeerKind, peerOf, type A2ARemotePeer } from "../../../src/a2a/client/a2a-card.js";
import { callPeerOf, DEFAULT_MESSAGE_RETENTION } from "../../../src/a2a/client/a2a-call-peer.js";
import { notSentOf } from "../../../src/a2a/client/a2a-reconcile.js";
import { NotSentTrust } from "../../../src/app/outbound-call-contract.js";
import type { App } from "../../../src/app/types.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { hours, minutes, seconds } from "../../../src/units/index.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { DirectApplication, QuoteAgent, QuotesA2AExpose } from "../fixtures/direct.application.js";
import { callerOf } from "./fixtures/caller.js";
import { agentMessage, scripts, SdkAgent, type AgentScript } from "./support/sdk-agent.js";
import { AgentEvent } from "@a2a-js/sdk/server";
import { A2ARemoteCallError, A2ARemoteCallReason } from "../../../src/a2a/index.js";

const PEER = { application: "peer-application", skill: "ask-workflow-start" };
const MESSAGE_SKILL = { "ask-workflow-start": { reply: "message" } };

const cardOf = (agent: SdkAgent): AgentCard => agent.card;

describe("#860 AC2: the retention a call to a direct-reply skill relies on", () => {
  const agboss = (options: {
    readonly message?: number;
    readonly skills?: Record<string, unknown>;
  }) =>
    new SdkAgent({
      script: scripts.messageEcho,
      agboss: {
        idempotencyRetention: hours(24),
        ...(options.message === undefined ? {} : { messageIdempotencyRetention: options.message }),
        skills: options.skills ?? {},
      },
    });

  it("AC2: a message skill's card retention, the 15 min default without one; a task skill's 24 h", () => {
    const declared = cardOf(agboss({ message: seconds(90), skills: MESSAGE_SKILL }));
    const undeclared = cardOf(agboss({ skills: MESSAGE_SKILL }));
    const task = cardOf(
      agboss({ message: seconds(90), skills: { "ask-workflow-start": { reply: "task" } } }),
    );

    const retentionOf = (card: AgentCard, skill?: string) =>
      callPeerOf(card, peerOf(card), skill).idempotencyRetention;
    expect(retentionOf(declared, "ask-workflow-start")).toBe(seconds(90));
    // the card's only skill when the call names none
    expect(retentionOf(declared)).toBe(seconds(90));
    expect(retentionOf(undeclared, "ask-workflow-start")).toBe(DEFAULT_MESSAGE_RETENTION);
    expect(DEFAULT_MESSAGE_RETENTION).toBe(minutes(15));
    expect(retentionOf(task, "ask-workflow-start")).toBe(hours(24));
    expect(retentionOf(declared, "another-skill")).toBe(hours(24));
  });

  it("AC2: OutboundCalls is told the message retention: KeyReplay within it, nothing resent past it", () => {
    const card = cardOf(agboss({ message: minutes(15), skills: MESSAGE_SKILL }));

    const notSent = notSentOf(callPeerOf(card, peerOf(card), "ask-workflow-start"));

    expect(notSent).toEqual({ trust: NotSentTrust.KeyReplay, keyRetention: minutes(15) });
  });

  it("AC2: a foreign peer stays foreign, whatever its skills say", () => {
    const foreign: A2ARemotePeer = {
      kind: A2APeerKind.Foreign,
      idempotencyRetention: undefined,
      mesh: false,
    };
    const card = cardOf(agboss({ message: minutes(15), skills: MESSAGE_SKILL }));

    expect(callPeerOf(card, foreign, "ask-workflow-start")).toBe(foreign);
  });
});

const apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** A stateless message of one data part: the text back, upper-cased, as the output DTO's field. */
const dataEcho: AgentScript = async (context, bus) => {
  const text = context.userMessage.parts.find((part) => part.content?.$case === "text");
  const value = text?.content?.$case === "text" ? text.content.value : "";
  const part = {
    content: { $case: "data" as const, value: { text: value.toUpperCase() } },
    metadata: undefined,
    filename: "",
    mediaType: "application/json",
  };
  bus.publish(AgentEvent.message(agentMessage(context, [part])));
  bus.finished();
};

describe("#860 AC2: a Message answer inside an execution", () => {
  it("AC2: a message with no readable output is A2ARemoteCallError NoTask, never an empty answer", async () => {
    const agent = new SdkAgent({ script: scripts.messageEcho });
    const parts = await callerOf({ agent });
    apps.push(parts.app);

    await parts.ask("price?").catch(() => undefined);

    expect(parts.errors).toEqual([expect.objectContaining({ reason: A2ARemoteCallReason.NoTask })]);
    expect(parts.errors[0]).toBeInstanceOf(A2ARemoteCallError);
  });

  it("AC2: a message whose ids are not ids (an unsafe contextId) is MalformedAnswer, nothing kept of it", async () => {
    const forged: AgentScript = async (context, bus) => {
      const message = { ...agentMessage(context, []), contextId: `${"x".repeat(200)}\n` };
      bus.publish(AgentEvent.message(message));
      bus.finished();
    };
    const parts = await callerOf({ agent: new SdkAgent({ script: forged }) });
    apps.push(parts.app);

    await parts.ask("price?").catch(() => undefined);

    expect(parts.errors).toEqual([
      expect.objectContaining({ reason: A2ARemoteCallReason.MalformedAnswer }),
    ]);
  });

  it("AC2: the reply is the output, no task waited for; an ambiguous send is resent with its messageId", async () => {
    const agent = new SdkAgent({
      script: dataEcho,
      agboss: {
        idempotencyRetention: hours(24),
        messageIdempotencyRetention: minutes(15),
        skills: MESSAGE_SKILL,
      },
    });
    agent.loseSendAnswers = 1;
    const parts = await callerOf({ agent, target: PEER });
    apps.push(parts.app);

    await parts.ask("price?");

    const sends = agent.received.filter((request) => request.method === "SendMessage");
    expect(sends).toHaveLength(2);
    expect(sends[1]?.messageId).toBe(sends[0]?.messageId);
    expect(agent.count("GetTask")).toBe(0);
    expect(agent.count("SubscribeToTask")).toBe(0);
    expect(parts.errors).toEqual([]);
    expect(parts.replies).toEqual([{ text: "PRICE?#0" }]);
  });
});

const test = testWith(DirectApplication);
const listener = { expose: QuotesA2AExpose, callerResolver: BearerCallerResolver };

describe("#860 AC2: A2AClient against an AGBoss direct-reply skill", () => {
  test("AC2: execute and send get the reply; a second call is another message, the model called again", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."), replyWith("13 EUR."));
    const { url } = await a2aServer(listener);
    const client = new A2AClient<WorkflowStartTextDto, WorkflowFinishTextDto>({
      url,
      headers: { authorization: "Bearer dana" },
      contract: {
        skill: "quote-workflow-start",
        input: WorkflowStartTextDto,
        output: WorkflowFinishTextDto,
      },
    });

    const typed = await client.execute({ text: "price of sku-1?" });
    const untyped = await client.send("price of sku-2?");

    expect(typed).toEqual({ text: "12.50 EUR." });
    expect(untyped.task).toBeUndefined();
    expect(untyped.text).toBe("13 EUR.");
    expect(untyped.message?.messageId).toMatch(/:reply$/);
  });
});
