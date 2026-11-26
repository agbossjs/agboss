import { describe, expect, it } from "vitest";
import { CostSource } from "../../src/finops/cost-source.js";
import { decisionSpendOf } from "../../src/finops/failed-decision.js";
import { createProviderGateway } from "../../src/llm/gateway.js";
import {
  CircuitBreakerPolicy,
  DecisionsDriver,
  ModelCost,
  ModelProvider,
  RetryPolicy,
} from "../../src/models/index.js";
import { ModelProviderDirectory } from "../../src/models/resolve.js";
import { minutes, seconds } from "../../src/units/index.js";
import { instanceCalls } from "./gateway.js";
import { providerStub, type StubReply } from "./stub.js";

/**
 * #1313d: a decision down its provider's fallback chain — the same failover rules as a chat call, each
 * provider asked once, the answering one recorded.
 */

const common = {
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 3,
    failureWindow: minutes(1),
    openDuration: seconds(30),
  }),
};

@ModelProvider({
  ...common,
  name: "backup-decisions",
  driver: DecisionsDriver({ baseUrl: "http://backup.test/v1" }),
  model: "backup/decide",
})
class BackupDecisions {}

@ModelProvider({
  ...common,
  name: "primary-decisions",
  driver: DecisionsDriver({ baseUrl: "http://primary.test/v1" }),
  model: "primary/decide",
  fallback: { provider: BackupDecisions },
})
class PrimaryDecisions {}

const answer = (cost: number): StubReply => ({
  body: { answers: { q: { type: "boolean", probability: 0.9 } }, usage: { cost } },
});
const asked = {
  caller: "judge:j",
  model: "primary/decide",
  modelProvider: "primary-decisions",
  request: { state: "x", questions: { q: { type: "boolean", instructions: "Is it?" } } },
} as const;

function gatewayOver(primary: readonly StubReply[], backup: readonly StubReply[]) {
  const first = providerStub(primary);
  const second = providerStub(backup);
  const send: typeof fetch = (input, init) =>
    ((input instanceof Request ? input.url : input.toString()).includes("backup.test")
      ? second
      : first
    ).fetch(input, init);
  const gateway = createProviderGateway(ModelProviderDirectory.of([PrimaryDecisions]), {
    env: {},
    calls: instanceCalls(),
    send,
  });
  return { gateway, first, second };
}

describe("#1313d: a decision call down the fallback chain", () => {
  it("a failed primary (503) is answered by the backup, recorded under the backup's provider and model, once", async () => {
    const { gateway, first, second } = gatewayOver([{ status: 503 }], [answer(0.004)]);

    const outcome = await gateway.decide(asked);

    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]?.body).toMatchObject({ model: "backup/decide" });
    expect(outcome.usage).toMatchObject({
      provider: "backup-decisions",
      model: "backup/decide",
      costSource: CostSource.Api,
    });
    expect(outcome.usage.costUsd).toBe(0.004);
  });

  it("a request the primary refused as wrong (a moderation 403, a 400) is not sent to the backup", async () => {
    for (const status of [400, 403]) {
      const { gateway, second } = gatewayOver([{ status }], [answer(0.004)]);

      await expect(gateway.decide(asked)).rejects.toThrow();

      expect(second.requests).toEqual([]);
    }
  });

  it("an answering primary never reaches the backup", async () => {
    const { gateway, second } = gatewayOver([answer(0.001)], [answer(0.004)]);

    const outcome = await gateway.decide(asked);

    expect(second.requests).toEqual([]);
    expect(outcome.usage.model).toBe("primary/decide");
  });

  it("a backup that answers with something unusable carries its billed record, under the backup", async () => {
    const unusable: StubReply = { body: { answers: {}, usage: { cost: 0.002, input_tokens: 4 } } };
    const { gateway } = gatewayOver([{ status: 503 }], [unusable]);

    const error = await gateway.decide(asked).catch((thrown: unknown) => thrown);

    expect(decisionSpendOf(error)).toMatchObject({
      provider: "backup-decisions",
      model: "backup/decide",
      costSource: CostSource.Api,
      inputTokens: 4,
    });
  });
});
