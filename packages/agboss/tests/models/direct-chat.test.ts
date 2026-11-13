import { createServer, type Server } from "node:http";
import { tool } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResolvedModelSettings } from "../../src/config/types.js";
import { PromptCaching, Reasoning } from "../../src/models/index.js";
import { LocalModelProvider } from "./providers.fixture.js";

const settings: ResolvedModelSettings = { model: "local/model", temperature: 0, maxTokens: 50 };
const bodies: unknown[] = [];
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += String(chunk)));
    request.on("end", () => {
      const body: unknown = JSON.parse(raw);
      bodies.push(body);
      if (typeof body === "object" && body !== null && "stream" in body && body.stream === true) {
        response.setHeader("content-type", "text/event-stream");
        const delta = (content: string, finish: string | null) =>
          `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "local/model", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
        response.end(`${delta("po", null)}${delta("ng", "stop")}data: [DONE]\n\n`);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: "local/model",
          choices: [
            { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? String(address.port) : "0"}/v1`;
});

afterAll(() => {
  server.close();
});

const chatOf = () =>
  new LocalModelProvider().chat({
    settings,
    reasoning: Reasoning.modelDecides(),
    promptCaching: PromptCaching.off(),
    connection: { provider: "local", baseUrl, apiKey: undefined, fetch },
  });

describe("a provider's chat() called directly, outside createApp (#956)", () => {
  it("returns a working model without any preload: the client loads on its first call", async () => {
    vi.resetModules();
    const answer = await chatOf().invoke([new HumanMessage("ping")]);

    expect(answer.content).toBe("pong");
    expect(answer.usage_metadata?.total_tokens).toBe(4);
  });

  it("streams the client's chunks", async () => {
    const chunks: string[] = [];
    for await (const chunk of await chatOf().stream([new HumanMessage("ping")])) {
      chunks.push(chunk.text);
    }

    expect(chunks.join("")).toBe("pong");
  });

  it("passes bound tools on to the client", async () => {
    const lookup = tool(async () => "x", {
      name: "lookup",
      description: "looks up",
      schema: z.object({}),
    });
    const before = bodies.length;
    const model = chatOf().bindTools?.([lookup]);

    await model?.invoke([new HumanMessage("ping")]);

    expect(JSON.stringify(bodies[before])).toContain('"lookup"');
  });
});
