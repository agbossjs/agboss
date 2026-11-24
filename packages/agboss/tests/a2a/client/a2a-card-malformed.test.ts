/**
 * #1396, #1397: a remote card is untrusted input. A malformed `skills`, `capabilities` or interface
 * is `A2AProtocolError` (never a `TypeError`, none of the card's text in it); a card over the size
 * bound is cut off while it is read; one with more interfaces than a card may list is refused, and
 * a card at the limit is read in linear time.
 */
import { describe, expect, it } from "vitest";
import { fetchCard } from "../../../src/a2a/client/a2a-card.js";
import { MAX_CARD_BYTES } from "../../../src/a2a/client/a2a-card-shape.js";
import { A2AProtocolError } from "../../../src/a2a/client/a2a-client-errors.js";

const URL_OK = "http://agent.test/a2a";
const POLICY = { agent: "peer", origins: ["http://agent.test"] };
const SECRET = "card-secret-text-9f3a";

const face = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  url: URL_OK,
  protocolBinding: "JSONRPC",
  protocolVersion: "1.0",
  tenant: "",
  ...over,
});
const goodCard = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "peer",
  description: "a peer",
  version: "1.0.0",
  supportedInterfaces: [face()],
  skills: [{ id: "ask", name: "ask", description: "asks", tags: [], examples: [] }],
  capabilities: {},
  ...over,
});
const answering =
  (
    body: ConstructorParameters<typeof Response>[0],
    headers: Record<string, string> = {},
  ): typeof fetch =>
  () =>
    Promise.resolve(new Response(body, { headers }));
const jsonOf = (card: unknown): typeof fetch => answering(JSON.stringify(card));

async function refusal(fetchImpl: typeof fetch): Promise<unknown> {
  try {
    await fetchCard(URL_OK, fetchImpl, POLICY);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("#1396: a malformed part of a card is a protocol error, not a TypeError", () => {
  it.each([
    ["skills null", { skills: null }],
    ["skills 42", { skills: 42 }],
    ["skills a string", { skills: "str" }],
    ["skills [null]", { skills: [null] }],
    ["skills [a text]", { skills: ["x"] }],
    ["a skill without an id", { skills: [{ name: "n" }] }],
    ["a skill whose id is a number", { skills: [{ id: 7 }] }],
    ["capabilities 42", { capabilities: 42 }],
    ["capabilities a list", { capabilities: [] }],
    ["extensions a string", { capabilities: { extensions: "x" } }],
    ["extensions [null]", { capabilities: { extensions: [null] } }],
    ["an extension without a uri", { capabilities: { extensions: [{ params: {} }] } }],
    ["an interface tenant that is a number", { supportedInterfaces: [face({ tenant: 5 })] }],
    ["an interface tenant that is an object", { supportedInterfaces: [face({ tenant: {} })] }],
    [
      "an interface binding that is a number",
      { supportedInterfaces: [face(), face({ protocolBinding: 5 })] },
    ],
  ])("%s", async (_name, over) => {
    const error = await refusal(jsonOf(goodCard({ ...over, description: SECRET })));

    expect(error).toBeInstanceOf(A2AProtocolError);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("a card the SDK's own reader cannot read is refused too, never a TypeError", async () => {
    const proto = goodCard({
      security: [{ schemes: {} }],
      securitySchemes: { a: null },
    });

    expect(await refusal(jsonOf(proto))).toBeInstanceOf(A2AProtocolError);
  });

  it("a well-formed card is read", async () => {
    const read = await fetchCard(URL_OK, jsonOf(goodCard()), POLICY);

    expect(read.card.skills.map((skill) => skill.id)).toEqual(["ask"]);
  });
});

describe("#1397: a card is bounded", () => {
  it("a body declared over the bound is refused before it is read", async () => {
    let isCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        isCancelled = true;
      },
    });

    const error = await refusal(answering(body, { "content-length": String(MAX_CARD_BYTES + 1) }));

    expect(error).toBeInstanceOf(A2AProtocolError);
    expect(isCancelled).toBe(true);
  });

  it("a stream with no length is cut off at the bound, not read whole", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(32);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const error = await refusal(answering(body));

    expect(error).toBeInstanceOf(A2AProtocolError);
    expect(pulled).toBeLessThan(MAX_CARD_BYTES * 2);
  });

  it("a card that is no JSON is a protocol error", async () => {
    expect(await refusal(answering("{ not json"))).toBeInstanceOf(A2AProtocolError);
  });

  it("a card with more interfaces than a card may list is refused", async () => {
    const many = Array.from({ length: 101 }, (_, n) =>
      face({ url: `http://agent.test/a${String(n)}` }),
    );

    expect(await refusal(jsonOf(goodCard({ supportedInterfaces: many })))).toBeInstanceOf(
      A2AProtocolError,
    );
  });

  it("a card at the limit is read whole, each usable interface kept once", async () => {
    const many = Array.from({ length: 100 }, (_, n) =>
      face({ url: `http://agent.test/a${String(n)}` }),
    );

    const read = await fetchCard(URL_OK, jsonOf(goodCard({ supportedInterfaces: many })), POLICY);

    expect(read.card.supportedInterfaces).toHaveLength(100);
    expect(new Set(read.card.supportedInterfaces.map((each) => each.url)).size).toBe(100);
  });

  it("an interface of a binding the client does not speak is not kept, though its url is usable", async () => {
    const card = goodCard({ supportedInterfaces: [face(), face({ protocolBinding: "GRPC" })] });

    const read = await fetchCard(URL_OK, jsonOf(card), POLICY);

    expect(read.card.supportedInterfaces.map((each) => each.protocolBinding)).toEqual(["JSONRPC"]);
  });
});
