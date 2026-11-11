/**
 * #860 AC2: a direct-reply skill (`A2AReply.Message`) answers `SendMessage` with a `Message` — no
 * task — and a resend or a concurrent duplicate of its `messageId` gets the same reply, its model
 * called and charged once; `returnImmediately` changes nothing; one `messageId` is one message
 * across both reply modes (`-32602 a2a.message-id-reused`); a direct skill has no task to read or
 * follow up (`-32001`); `defaultSkill` takes a message that names no skill.
 */
import { describe, expect } from "vitest";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../../../src/a2a/index.js";
import { A2ADirectMessageRepository } from "../../../src/infrastructure/a2a-direct-message.repository.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { DirectApplication, QuoteAgent, QuotesA2AExpose } from "../fixtures/direct.application.js";
import { errorInfoOf, errorOf, rpc, text, userMessage, type RpcAnswer } from "../server/rpc.js";

const test = testWith(DirectApplication);
const listener = { expose: QuotesA2AExpose, callerResolver: BearerCallerResolver };
const QUOTE = { [A2A_SKILLS_EXTENSION]: { skill: "quote-workflow-start" } };
const ACK = { [A2A_SKILLS_EXTENSION]: { skill: "ack-workflow-start" } };

interface WireMessage {
  readonly messageId: string;
  readonly contextId: string;
  readonly taskId?: string;
  readonly role: string;
  readonly parts: readonly Record<string, unknown>[];
  readonly metadata?: Record<string, unknown>;
}

const messageOf = (answer: RpcAnswer): WireMessage => {
  const result = answer.body.result as { message?: WireMessage } | undefined;
  if (result?.message === undefined) throw new Error(`no message: ${JSON.stringify(answer.body)}`);
  return result.message;
};

const quote = (messageId: string, words = "price of sku-1?", fields = {}) => ({
  message: userMessage(messageId, [text(words)], { metadata: QUOTE, ...fields }),
});

describe("#860 AC2: a direct reply over SendMessage", () => {
  test("AC2: the skill answers with a Message of its finish's text, no task", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("sku-1 costs 12.50 EUR."));
    const { url } = await a2aServer(listener);

    const reply = messageOf(await rpc(url, "SendMessage", quote("m-1")));

    expect(reply).toMatchObject({
      role: "ROLE_AGENT",
      parts: [{ text: "sku-1 costs 12.50 EUR.", mediaType: "text/plain" }],
      metadata: { [A2A_SKILLS_EXTENSION]: { finish: "quote-workflow-finish" } },
    });
    expect(reply.taskId ?? "").toBe("");
    expect(reply.contextId).not.toBe("");
    expect(reply.metadata?.[A2A_MESH_EXTENSION]).toBeUndefined();
  });

  test("AC2: a resend of the messageId gets the same message; the model is called and charged once", async ({
    a2aServer,
    app,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."));
    const { url } = await a2aServer(listener);

    const first = messageOf(await rpc(url, "SendMessage", quote("m-1")));
    const again = messageOf(await rpc(url, "SendMessage", quote("m-1")));
    const immediate = messageOf(
      await rpc(url, "SendMessage", {
        ...quote("m-1"),
        configuration: { returnImmediately: true },
      }),
    );

    expect(again).toEqual(first);
    expect(immediate).toEqual(first);
    expect(mockLlm(QuoteAgent).requests).toHaveLength(1);
    const kept = await app
      .resolve(A2ADirectMessageRepository)
      .findByKey({ tenantId: "default", ownerId: "dana", messageId: "m-1" });
    expect(kept?.reply?.finish).toBe("quote-workflow-finish");
  });

  test("AC2: two concurrent sends of one messageId: one run, one model call, the same message", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."));
    const { url } = await a2aServer(listener);

    const [one, two] = await Promise.all([
      rpc(url, "SendMessage", quote("m-1")),
      rpc(url, "SendMessage", quote("m-1")),
    ]);

    expect(messageOf(two)).toEqual(messageOf(one));
    expect(mockLlm(QuoteAgent).requests).toHaveLength(1);
  });

  test("AC2: the same messageId with other content is -32602, the reply kept as it was", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."));
    const { url } = await a2aServer(listener);

    await rpc(url, "SendMessage", quote("m-1"));
    const other = await rpc(url, "SendMessage", quote("m-1", "price of sku-2?"));

    expect(errorOf(other).code).toBe(-32602);
    expect(errorInfoOf(other)?.code).toBe("a2a.message-id-reused");
    expect(mockLlm(QuoteAgent).requests).toHaveLength(1);
  });

  test("AC2: one messageId is one message across reply modes: a task's id or a reply's is -32602 for the other", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."));
    const { url } = await a2aServer(listener);

    await rpc(url, "SendMessage", {
      message: userMessage("m-task", [text("hi")], { metadata: ACK }),
    });
    await rpc(url, "SendMessage", quote("m-direct"));
    const toDirect = await rpc(url, "SendMessage", quote("m-task"));
    const toTask = await rpc(url, "SendMessage", {
      message: userMessage("m-direct", [text("hi")], { metadata: ACK }),
    });

    expect(errorInfoOf(toDirect)?.code).toBe("a2a.message-id-reused");
    expect(errorInfoOf(toTask)?.code).toBe("a2a.message-id-reused");
    expect(mockLlm(QuoteAgent).requests).toHaveLength(1);
  });

  test("AC2: a direct skill has no task: GetTask of its reply and a follow-up naming it are -32001", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."));
    const { url } = await a2aServer(listener);

    const reply = messageOf(await rpc(url, "SendMessage", quote("m-1")));
    const read = await rpc(url, "GetTask", { id: reply.messageId.replace(/:reply$/, "") });
    const followUp = await rpc(url, "SendMessage", quote("m-2", "and sku-2?", { taskId: "t-1" }));

    expect(errorOf(read).code).toBe(-32001);
    expect(errorOf(followUp).code).toBe(-32001);
  });

  test("AC2: a message that names no skill runs the defaultSkill", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."));
    const { url } = await a2aServer(listener);

    const reply = messageOf(
      await rpc(url, "SendMessage", { message: userMessage("m-1", [text("price?")]) }),
    );

    expect(reply.parts).toEqual([{ text: "12.50 EUR.", mediaType: "text/plain" }]);
  });
});
