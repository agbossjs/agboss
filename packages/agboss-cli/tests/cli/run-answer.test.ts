/**
 * #1005 AC5: `agboss run "<task>"` without --json prints the answer — streamed from the model, or
 * from the result when nothing streamed — and prints it once.
 */
import { afterAll, describe, expect, it } from "vitest";
import { unstreamedAnswer } from "../../src/cli/approve.js";
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

describe("#1005 AC5: the answer from the result when nothing streamed", () => {
  it("is the result's text, a JSON output as JSON, nothing for no output or a streamed answer", () => {
    expect(unstreamedAnswer({ output: { text: "From the result." } }, false)).toBe(
      "From the result.",
    );
    expect(unstreamedAnswer({ output: { n: 1 } }, false)).toBe('{\n  "n": 1\n}');
    expect(unstreamedAnswer({ output: undefined }, false)).toBeUndefined();
    expect(unstreamedAnswer({ output: { text: "streamed" } }, true)).toBeUndefined();
  });
});
