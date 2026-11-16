/**
 * #1005 AC5: `agboss run "<task>"` without --json prints the answer — streamed from the model, or
 * from the result when nothing streamed — and prints it once.
 */
import { afterAll, describe, expect, it } from "vitest";
import { unstreamedAnswer } from "../../src/cli/approve.js";
import { KeptText } from "../../src/cli/kept-text.js";
import { plainOf, sseServer, streamOf } from "../../../agboss/tests/models/streaming/sse-server.js";
import { agboss, fixture } from "./agboss.js";

const APPLICATION = fixture("cli/stream/stream.workflow.ts");
const servers: Awaited<ReturnType<typeof sseServer>>[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function run(argv: readonly string[], tokens: readonly string[]) {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 };
  const server = await sseServer([streamOf(tokens, usage)], plainOf(tokens.join(""), usage));
  servers.push(server);
  const env = { OPENROUTER_API_KEY: "key", OPENROUTER_BASE_URL: `${server.url}/v1` };
  const call = await agboss(["run", "--application", APPLICATION, ...argv], process.cwd(), env);
  return { call, requests: server.requests };
}

describe("#1005 AC5: agboss run prints the answer", () => {
  it("streams the model's tokens to stdout, the answer once, with the cost on stderr", async () => {
    const { call, requests } = await run(["What is the answer?"], ["The ", "answer is ", "42."]);

    expect(call.code).toBe(0);
    expect(requests.some((request) => request.body.stream === true)).toBe(true);
    expect(call.stdout.trim()).toBe("The answer is 42.");
    expect(call.stderr).toMatch(/cost: /);
  });

  it("--json keeps stdout for the envelope: the answer is its text, the stream goes to stderr", async () => {
    const { call } = await run(["What is the answer?", "--json"], ["The answer is 42."]);

    expect(JSON.parse(call.stdout)).toMatchObject({ result: { text: "The answer is 42." } });
    expect(call.stderr).toContain("The answer is 42.");
  });
});

describe("#1005 AC5 / #1123 AC2: the answer from the result unless it is already on the screen", () => {
  it("is the result's text, a JSON output as JSON, nothing for no output or the kept text being the output", () => {
    expect(unstreamedAnswer({ output: { text: "From the result." } }, "")).toBe("From the result.");
    expect(unstreamedAnswer({ output: { n: 1 } }, "")).toBe('{\n  "n": 1\n}');
    expect(unstreamedAnswer({ output: undefined }, "")).toBeUndefined();
    expect(unstreamedAnswer({ output: undefined }, "something")).toBeUndefined();
    expect(unstreamedAnswer({ output: { text: "streamed" } }, "streamed")).toBeUndefined();
    expect(unstreamedAnswer({ output: { text: "streamed" } }, " streamed\n")).toBeUndefined();
    expect(unstreamedAnswer({ output: { text: " streamed\n" } }, "streamed")).toBeUndefined();
  });

  it("#1123 AC2: a kept text that is not the output (another step's) does not suppress the answer", () => {
    expect(unstreamedAnswer({ output: { text: "Final." } }, "Let me refund that now.")).toBe(
      "Final.",
    );
  });
});

describe("#1123 AC2: the kept text of a stream", () => {
  const step = { agent: "a", visit: 1, branch: "e", attempt: 1 };

  it("is the deltas of the steps that were not retracted; a retracted one is gone, a retry is another step", () => {
    const kept = new KeptText();

    kept.hear({ kind: "textDelta", delta: "Let me ", step });
    kept.hear({ kind: "textDelta", delta: "refund.", step });
    kept.hear({ kind: "toolCall", tool: "t" });
    kept.hear({ kind: "discarded", step, reason: "tool-turn" });
    expect(kept.text()).toBe("");

    kept.hear({ kind: "textDelta", delta: "Done", step: { ...step, attempt: 2 } });
    kept.hear({ kind: "textDelta", delta: "!", step: { ...step, attempt: 2 } });
    kept.hear({ kind: "textDelta", delta: "Other", step: { ...step, agent: "b" } });
    expect(kept.text()).toBe("Done!Other");

    kept.hear({ kind: "discarded", step: { ...step, attempt: 2 }, reason: "judge-rejected" });
    expect(kept.text()).toBe("Other");
  });

  it("a step that is retracted and answers again under the same key is kept again", () => {
    const kept = new KeptText();
    kept.hear({ kind: "textDelta", delta: "old", step });
    kept.hear({ kind: "discarded", step, reason: "tool-turn" });
    kept.hear({ kind: "textDelta", delta: "new", step });
    expect(kept.text()).toBe("new");
  });
});
