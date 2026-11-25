import { usd } from "../../../src/units/index.js";
/**
 * #385 — a breaker's fallback at the chat model: transport → HTTP and HTTP → transport, each call
 * sent as the fallback's model and priced by its table; PII masked in what `complete()` reads; and
 * `mockModel` of `testWith` answers above the transport (its `complete()` is never called).
 */
import { describe, expect, it } from "vitest";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { completion, providerStub } from "../stub.js";
import {
  BEDROCK_DESK,
  BedrockApplication,
  BedrockContactPiiPolicy,
  HttpToTransportApplication,
  TransportToHttpApplication,
  bedrockApplicationOn,
} from "./bedrock-apps.fixture.js";
import { answer, ScriptedBedrockClient } from "./bedrock-provider.fixture.js";
import { transportApp } from "./transport-app.js";

/** The backup's answer: 1M input and 0.5M output tokens, no cost of its own. */
const backupAnswer = {
  body: {
    ...(completion("from backup").body as Record<string, unknown>),
    usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
  },
};

describe("#385: the breaker's fallback works both ways between HTTP and transport providers", () => {
  it("transport → HTTP: with its breaker open, the call goes out as backup/claude at the backup's prices", async () => {
    const client = new ScriptedBedrockClient([new Error("ThrottlingException")]);
    const backup = providerStub([backupAnswer], [{ id: "backup/claude" }]);
    const app = await transportApp(TransportToHttpApplication, { client, send: backup.fetch });

    // the first call fails after its retries: the fallback answers it, the breaker opens
    await execute(app, ChatStart, { text: "first" });
    const result = await execute(app, ChatStart, { text: "second" });

    expect(client.invocations).toHaveLength(1);
    expect(result.output).toEqual({ text: "from backup" });
    const chats = backup.requests.filter((request) => request.url.endsWith("/chat/completions"));
    expect(chats.map((request) => request.body?.model)).toEqual(["backup/claude", "backup/claude"]);
    // 1M input × $10 + 0.5M output × $20 = $20
    expect(result.spend.trace).toEqual([
      expect.objectContaining({
        model: "backup/claude",
        costUsd: usd(20),
        costSource: "price-table",
      }),
    ]);
    await app.close();
  });

  it("HTTP → transport: with the HTTP breaker open, complete() gets bedrock/claude, priced by its table", async () => {
    const client = new ScriptedBedrockClient([answer("from bedrock")]);
    const primary = providerStub([{ status: 500 }], [{ id: "primary/model" }]);
    const app = await transportApp(HttpToTransportApplication, { client, send: primary.fetch });

    // the first call fails after its retries: the fallback answers it, the breaker opens
    await execute(app, ChatStart, { text: "first" });
    const result = await execute(app, ChatStart, { text: "second" });

    expect(result.output).toEqual({ text: "from bedrock" });
    expect(client.invocations.map((call) => call.model)).toEqual([
      "bedrock/claude",
      "bedrock/claude",
    ]);
    // 1M input × $3 + 0.5M output × $15 = $10.50
    expect(result.spend.trace).toEqual([
      expect.objectContaining({
        model: "bedrock/claude",
        costUsd: usd(10.5),
        costSource: "price-table",
      }),
    ]);
    await app.close();
  });
});

describe("#385: what complete() reads and who answers in tests", () => {
  it("PII: the messages complete() gets are masked by the application's policies", async () => {
    const client = new ScriptedBedrockClient([answer("Sent.")]);
    const application = bedrockApplicationOn({
      name: "masked-bedrock-application",
      piiPolicies: [BedrockContactPiiPolicy],
    });
    const app = await transportApp(application, { client });

    await execute(app, ChatStart, { text: "mail alice@example.com" });

    const read = client.invocations[0]?.messages.map((message) => message.text).join("\n") ?? "";
    expect(read).not.toContain("alice@example.com");
    expect(read).toContain("mail <email>");
    await app.close();
  });

  const scripted = testWith(BedrockApplication);

  scripted(
    "mockModel answers above the transport: complete() is never called",
    async ({ app, mockModel }) => {
      mockModel(BEDROCK_DESK.textAgent).thenReturn(replyWith("scripted"));

      const result = await execute(app, ChatStart, { text: "hi" });

      // the real BedrockSdkClient rejects every call: an answer means the transport was not reached
      expect(result.output).toEqual({ text: "scripted" });
    },
  );
});
