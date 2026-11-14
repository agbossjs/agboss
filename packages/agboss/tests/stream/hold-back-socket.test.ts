/**
 * #1006 AC3 at the socket: the raw bytes an A2A client receives from `SendStreamingMessage` never
 * hold the text of an answer the agent's output guardrail or PII block rule refused.
 */
import { request } from "node:http";
import { describe, expect } from "vitest";
import { replyWith, testWith } from "../../src/testing/index.js";
import { rpcBody } from "../a2a/server/rpc.js";
import { text, userMessage } from "../a2a/server/rpc.js";
import { FlowJudge } from "./agents.fixture.js";
import { WireApplication, wireListener } from "./a2a-guarded.fixture.js";
import { GuardedAgent } from "./guarded.fixture.js";

const test = testWith(WireApplication);

/** Everything the server wrote to the socket for one streaming request, as text. */
function bytesOf(url: string, question: string): Promise<{ status: number; body: string }> {
  const body = rpcBody("SendStreamingMessage", {
    message: userMessage("m-socket", [text(question)]),
    configuration: { returnImmediately: false },
  });
  return new Promise((resolve, reject) => {
    const call = request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dana",
          "a2a-version": "1.0",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    call.on("error", reject);
    call.end(body);
  });
}

describe("#1006: blocked text is not on the wire", () => {
  test("AC3: a guardrail-blocked answer: no byte of it; the task ends FAILED", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(GuardedAgent).thenReturn(replyWith("Here is the FORBIDDEN thing."));
    mockLlm(FlowJudge).thenReturn(replyWith("PASS"));
    const { url } = await a2aServer(wireListener);

    const wire = await bytesOf(url, "Q");

    expect(wire.status).toBe(200);
    expect(wire.body).toContain("TASK_STATE_FAILED");
    expect(wire.body).not.toContain("FORBIDDEN");
    expect(wire.body).not.toContain("Here is the");
  });

  test("AC3: a PII-refused card number: no byte of it", async ({ a2aServer, mockLlm }) => {
    mockLlm(GuardedAgent).thenReturn(replyWith("Your card is 4242 4242 4242 4242."));
    const { url } = await a2aServer(wireListener);

    const wire = await bytesOf(url, "Q");

    expect(wire.body).toContain("TASK_STATE_FAILED");
    expect(wire.body).not.toContain("4242");
    expect(wire.body).not.toContain("Your card is");
  });

  test("control: a passing answer is on the wire (the capture works)", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(GuardedAgent).thenReturn(replyWith("A fine answer."));
    mockLlm(FlowJudge).thenReturn(replyWith("PASS"));
    const { url } = await a2aServer(wireListener);

    const wire = await bytesOf(url, "Q");

    expect(wire.body).toContain("A fine answer.");
    expect(wire.body).toContain("TASK_STATE_COMPLETED");
  });
});
