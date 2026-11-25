import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { usd } from "../../src/units/index.js";
/** #202 AC3: a fallback call is sent as the fallback's model and priced with the fallback's prices. */
import { describe, expect, it } from "vitest";
import { appWithKeys } from "../models/gateway.js";
import type { ProviderFetch } from "../../src/models/resilient-fetch.js";
import { createSqliteTurnStore } from "../../src/turns/index.js";
import { ChatStart } from "../channels/approval.workflow.js";
import { completion, providerStub } from "../models/stub.js";
import { UnmappedFallbackApplication, WithFallbackApplication } from "./fallback.workflow.js";
import { execute } from "../helpers/flow.js";

const env = {};
/** The backup's answer: 1M input and 0.5M output tokens, no cost of its own (it prices by table). */
const answered = {
  body: {
    ...(completion("from backup").body as Record<string, unknown>),
    usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
  },
};

describe("#202 AC3: the fallback provider has its own model mapping and prices", () => {
  it("AC3: with the primary's breaker open, the call goes out as backup/model and costs backup's prices", async () => {
    const primary = providerStub([{ status: 500 }], [{ id: "primary/model" }]);
    const backup = providerStub([answered], [{ id: "backup/model" }]);
    const send: ProviderFetch = (input, init) =>
      String(input instanceof Request ? input.url : input).startsWith("http://backup-202.test")
        ? backup.fetch(input, init)
        : primary.fetch(input, init);
    const app = await appWithKeys(WithFallbackApplication, {
      processEnv: env,
      providerFetch: send,
    });

    // the first call fails after its retries: the fallback answers it, the breaker opens
    await execute(app, ChatStart, { text: "first" });
    const result = await execute(app, ChatStart, { text: "second" });

    expect(primary.requests.filter((r) => r.url.endsWith("/chat/completions"))).toHaveLength(1);
    // the start reads the backup's model list for the input kinds it takes (#899 §4): only the chat call matters here
    const chats = backup.requests.filter((r) => r.url.endsWith("/chat/completions"));
    expect(chats.map((request) => request.body?.model)).toEqual(["backup/model", "backup/model"]);
    expect(result.output).toEqual({ text: "from backup" });
    // 1M input × $10 + 0.5M output × $20 = $20 — the primary's table would say $2
    expect(result.spend.trace).toEqual([
      expect.objectContaining({
        model: "backup/model",
        costUsd: usd(20),
        costSource: "price-table",
      }),
    ]);
    await app.close();
  });

  it("AC3: a fallback not told a model for a used model is sent it by name, and without a price for it fails at startup, before any call", async () => {
    const stub = providerStub([], [{ id: "primary/model" }]);
    const start = appWithKeys(UnmappedFallbackApplication, {
      processEnv: env,
      providerFetch: stub.fetch,
    });

    await expect(start).rejects.toBeInstanceOf(ConfigError.ModelSettings);
    await expect(start).rejects.toMatchObject({
      problems: [
        {
          code: "model.fallback-no-price",
          key: "agents.cashier-agent",
          model: "primary/model",
          supported: expect.stringContaining("has no price for primary/model"),
        },
      ],
    });
    expect(stub.requests).toEqual([]);
  });
});
