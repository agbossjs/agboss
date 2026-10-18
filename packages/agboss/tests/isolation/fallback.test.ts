/** #202 AC3: a fallback call is sent as the fallback's model and priced with the fallback's prices. */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { createMemoryLedger } from "../../src/finops/ledger.js";
import { ConfigurationError } from "../../src/models/index.js";
import type { ProviderFetch } from "../../src/models/resilient-fetch.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { ChatStart } from "../channels/approval.workflow.js";
import { completion, providerStub } from "../models/stub.js";
import { UnmappedFallbackApplication, WithFallbackApplication } from "./fallback.workflow.js";
import { execute } from "../helpers/flow.js";

const env = { OPENROUTER_API_KEY: "k" };
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
    const backup = providerStub([answered]);
    const send: ProviderFetch = (input, init) =>
      String(input instanceof Request ? input.url : input).startsWith("http://backup-202.test")
        ? backup.fetch(input, init)
        : primary.fetch(input, init);
    const app = await createApp(WithFallbackApplication, {
      processEnv: env,
      providerFetch: send,
    });

    await expect(execute(app, ChatStart, { text: "first" })).rejects.toThrow();
    const result = await execute(app, ChatStart, { text: "second" });

    expect(primary.requests.filter((r) => r.url.endsWith("/chat/completions"))).toHaveLength(1);
    expect(backup.requests.map((request) => request.body?.model)).toEqual(["backup/model"]);
    expect(result.output).toEqual({ text: "from backup" });
    // 1M input × $10 + 0.5M output × $20 = $20 — the primary's table would say $2
    expect(result.spend.trace).toEqual([
      expect.objectContaining({ model: "backup/model", costUsd: 20, costSource: "price-table" }),
    ]);
    await app.close();
  });

  it("AC3: a fallback without a model for a used model fails at startup, before any call", async () => {
    const stub = providerStub([], [{ id: "primary/model" }]);
    const start = createApp(UnmappedFallbackApplication, {
      processEnv: env,
      providerFetch: stub.fetch,
    });

    await expect(start).rejects.toBeInstanceOf(ConfigurationError);
    await expect(start).rejects.toMatchObject({
      problems: [{ code: "model.fallback-unmapped", key: "agents.cashier-agent" }],
    });
    expect(stub.requests).toEqual([]);
  });
});
