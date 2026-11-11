/**
 * #860 AC2: a direct reply on every wire — the official SDK client's `sendMessage` and
 * `sendMessageStream` (one frame: the message, then the end), a file reply as a file part (#859),
 * and the Agent Card that says which skills answer with a message and for how long a
 * `messageId` is deduplicated.
 */
import { describe, expect } from "vitest";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../../../src/a2a/index.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { DirectApplication, QuoteAgent, QuotesA2AExpose } from "../fixtures/direct.application.js";
import { rpc, sseEvents, text, userMessage } from "../server/rpc.js";
import { sdkClientOf, textMessage } from "../server/sdk-client.js";

const test = testWith(DirectApplication);
const listener = { expose: QuotesA2AExpose, callerResolver: BearerCallerResolver };
const QUOTE = { [A2A_SKILLS_EXTENSION]: { skill: "quote-workflow-start" } };
const FILE = { [A2A_SKILLS_EXTENSION]: { skill: "quote-file-workflow-start" } };

describe("#860 AC2: a direct reply on the wire", () => {
  test("AC2: the official SDK client's sendMessage gets a Message, a resend the same one", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."));
    const { url } = await a2aServer(listener);
    const client = await sdkClientOf(url);
    const request = { tenant: "", message: textMessage("m-1", "price?", { metadata: QUOTE }) };

    const answer = await client.sendMessage({
      ...request,
      configuration: undefined,
      metadata: undefined,
    });
    const again = await client.sendMessage({
      ...request,
      configuration: undefined,
      metadata: undefined,
    });

    expect("messageId" in answer).toBe(true);
    if (!("messageId" in answer)) return;
    expect(answer.parts[0]?.content).toEqual({ $case: "text", value: "12.50 EUR." });
    expect(again).toEqual(answer);
    expect(mockLlm(QuoteAgent).requests).toHaveLength(1);
  });

  test("AC2: SendStreamingMessage is one frame — the message — and the stream ends", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."));
    const { url } = await a2aServer(listener);

    const { contentType, events } = await sseEvents(url, "SendStreamingMessage", {
      message: userMessage("m-1", [text("price?")], { metadata: QUOTE }),
    });

    expect(contentType).toContain("text/event-stream");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      result: { message: { role: "ROLE_AGENT", parts: [{ text: "12.50 EUR." }] } },
    });
  });

  test("AC2: the SDK client's stream of a direct reply yields the message alone", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."));
    const { url } = await a2aServer(listener);
    const client = await sdkClientOf(url);

    const frames = [];
    for await (const frame of client.sendMessageStream({
      tenant: "",
      message: textMessage("m-1", "price?", { metadata: QUOTE }),
      configuration: undefined,
      metadata: undefined,
    }))
      frames.push(frame);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      payload: { $case: "message", value: { messageId: expect.stringMatching(/:reply$/) } },
    });
  });

  test("AC2: a finish with a file answers with its file part in Message.parts (#859)", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);

    const answer = await rpc(url, "SendMessage", {
      message: userMessage("m-1", [text("sku-1")], { metadata: FILE }),
    });
    const again = await rpc(url, "SendMessage", {
      message: userMessage("m-1", [text("sku-1")], { metadata: FILE }),
    });

    const message = (answer.body.result as { message: { parts: Record<string, unknown>[] } })
      .message;
    expect(message.parts).toEqual([
      expect.objectContaining({
        raw: Buffer.from("quote for sku-1").toString("base64"),
        mediaType: "text/plain",
        filename: "quote.txt",
      }),
    ]);
    expect(again.body.result).toEqual(answer.body.result);
  });

  test("AC2: the card says each skill's reply and the message idempotency retention", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);

    const card = (await (await fetch(`${url}/.well-known/agent-card.json`)).json()) as {
      capabilities: { extensions: { uri: string; params: Record<string, unknown> }[] };
    };

    const params = (uri: string) =>
      card.capabilities.extensions.find((extension) => extension.uri === uri)?.params;
    expect(params(A2A_MESH_EXTENSION)).toEqual({
      idempotencyRetention: "PT86400S",
      messageIdempotencyRetention: "PT900S",
    });
    const skills = params(A2A_SKILLS_EXTENSION)?.skills as Record<string, { reply: string }>;
    expect(skills["quote-workflow-start"]?.reply).toBe("message");
    expect(skills["ack-workflow-start"]?.reply).toBe("task");
  });
});
