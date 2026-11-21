/**
 * #1366 (ledger-a2a-client shard) — a call to an agent whose card says nothing of its capabilities is a poll of its
 * task, not a stream, and never a `TypeError`; a client with no headers of its own sends none.
 */
import { TaskState } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { A2AClient } from "../../../src/a2a/index.js";
import { AGENT_URL, scripts, SdkAgent } from "./support/sdk-agent.js";

const cardOf = (capabilities: Record<string, unknown> | undefined) => ({
  name: "plain-agent",
  description: "A foreign agent",
  version: "1.0.0",
  supportedInterfaces: [{ url: AGENT_URL, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  ...(capabilities === undefined ? {} : { capabilities }),
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "ask", name: "ask", description: "Answers", tags: ["ask"] }],
});

describe("#1366: a task of an agent whose card declares no capabilities", () => {
  it.each([
    ["no capabilities", undefined],
    ["capabilities that say nothing of streaming", {}],
    ["capabilities that do not stream", { streaming: false }],
  ])(
    "is waited for with %s: it completes and its text is the answer",
    async (_why, capabilities) => {
      const agent = new SdkAgent({
        script: scripts.completeWith({ text: "done" }),
        rawCard: cardOf(capabilities),
      });
      const client = new A2AClient({ url: AGENT_URL, fetcher: agent.fetcher });

      const answer = await client.send("hi");

      expect(answer.task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(answer.text).toBe("done");
    },
  );
});

describe("#1366: the headers a client has of its own", () => {
  class OpenClient extends A2AClient {
    own(): Promise<Record<string, string>> {
      return this.getHeaders();
    }
  }

  it("are none, as an empty set, until a subclass gives some", async () => {
    const headers = await new OpenClient({ url: AGENT_URL }).own();

    expect(headers).toEqual({});
  });
});
