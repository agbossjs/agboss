/**
 * #1123: `agboss run` after a pause prints the answer of the run that finished — the resume streams,
 * and a text retracted before the pause (the sentence before a tool call) never stands in for it.
 * A 127.0.0.1 stub answers like a model: a sentence and a tool call, then the final answer.
 */
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  chunk,
  sseEvents,
  sseServer,
  streamOf,
  type SseServer,
} from "../../../agboss/tests/models/streaming/sse-server.js";
import { agboss, fixture } from "./agboss.js";

const APPLICATION = fixture("cli/stream-pause/stream-pause.workflow.ts");
const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 };

const toolTurn = (said: string) => ({
  steps: [
    sseEvents(chunk({ role: "assistant", content: said })),
    sseEvents(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "pause-refund-tool", arguments: '{"orderId":"42"}' },
          },
        ],
      }),
    ),
    sseEvents(
      { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      {
        id: "c",
        model: "m",
        choices: [],
        usage: USAGE,
      },
      "[DONE]",
    ),
  ],
});

/** `agboss run` with `typed` on stdin (the approval answer), against a stub that says `turns`. */
async function run(typed: string, turns: readonly ReturnType<typeof toolTurn>[]) {
  const server = await sseServer([
    ...turns,
    streamOf(["Refunded order 42 - ", "FINAL ANSWER."], USAGE),
  ]);
  servers.push(server);
  const env = { OPENROUTER_API_KEY: "key", OPENROUTER_BASE_URL: `${server.url}/v1` };
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: Readable.from([typed]), configurable: true });
  try {
    return await agboss(
      [
        "run",
        "--application",
        APPLICATION,
        "--start",
        "pause-ask-workflow-start",
        "Refund order 42",
      ],
      process.cwd(),
      env,
    );
  } finally {
    if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
  }
}

describe("#1123 AC1+AC3: agboss run after an approval pause", () => {
  it("a tool turn with a sentence before the call: stdout ends with the final answer, exactly once", async () => {
    const call = await run("y\n", [toolTurn("Let me refund that now.")]);

    expect(call.code).toBe(0);
    expect(call.stdout.trimEnd().endsWith("Refunded order 42 - FINAL ANSWER.")).toBe(true);
    expect(call.stdout.split("FINAL ANSWER.")).toHaveLength(2); // once
    expect(call.stderr).toContain("[Retracted: tool-turn]");
    expect(call.stderr).toContain("[Agent is using tool: pause-refund-tool]");
  });

  it("a tool turn with no sentence before the call: the same", async () => {
    const call = await run("y\n", [toolTurn("")]);

    expect(call.code).toBe(0);
    expect(call.stdout.trimEnd()).toBe("Refunded order 42 - FINAL ANSWER.");
  });
});
