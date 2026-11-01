/**
 * #648 AC3 — a chat-model reply interpreter on one cheap real model, with only its own one-line
 * prompt: "ok but only up to $500" is the capped approval, "🤷" is not understood. Real models via
 * OpenRouter: only `make smoke`, skipped without a key, never in CI.
 */
import { describe, expect, it } from "vitest";
import type { AssembledReplyInterpreter } from "../../src/channels/discovery.js";
import { readByModel } from "../../src/channels/reply-reader.js";
import { Integer, Text } from "../../src/dto/index.js";
import { ToolCallApprovalDecisionDto } from "../../src/dto/standard/framework.js";
import { resolveEnvironment } from "../../src/environments/resolve.js";
import { secret } from "../../src/environments/secret.js";
import { createProviderGateway } from "../../src/llm/gateway.js";
import { ModelProviderDirectory, OpenRouterModelProvider } from "../../src/models/index.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { instanceCalls } from "../models/gateway.js";

const MODEL = process.env.AGBOSS_SMOKE_REPLY_MODEL ?? "openai/gpt-4.1-nano";

class PlacePurchaseOrderDto {
  @Text({ prompt: "who sells it" })
  supplier!: string;

  @Text({ prompt: "what is bought" })
  itemDescription!: string;

  @Integer({ prompt: "the order's total, in US dollars", min: 1 })
  amountUsd!: number;
}

const interpreter: AssembledReplyInterpreter = {
  channel: "purchase-approval-channel",
  interpreter: PlacePurchaseOrderDto, // its class is not read on this path
  name: "purchase-reply-interpreter",
  answer: ToolCallApprovalDecisionDto,
  approves: PlacePurchaseOrderDto,
  model: MODEL,
  instructions: "Read the approver's reply to the purchase order.",
};

const ask = {
  callId: "call-1",
  tool: "place-purchase-order-tool",
  arguments: { supplier: "Acme", itemDescription: "40 office chairs", amountUsd: 900 },
  summary: "Order 40 office chairs from Acme for $900",
};

function site() {
  const environment = resolveEnvironment(
    {
      name: "smoke",
      contract: "SmokeEnvironment",
      values: { openRouterApiKey: secret("OPENROUTER_API_KEY") },
    },
    process.env,
  );
  const gateway = createProviderGateway(ModelProviderDirectory.of([OpenRouterModelProvider]), {
    env: process.env,
    environment,
    calls: instanceCalls(),
  });
  const settings = { model: MODEL, temperature: 0, maxTokens: 300 };
  const pii = { policies: new PiiPolicySet([], ""), known: {} };
  return { gateway, settings, callbacks: [], pii };
}

describe.skipIf(!process.env.OPENROUTER_API_KEY)(`smoke: a reply interpreter on ${MODEL}`, () => {
  it("'ok but only up to $500' is an approval capped at $500, the call otherwise as it was", async () => {
    const reading = await readByModel(
      interpreter,
      { ask, reply: "ok but only up to $500" },
      site(),
    );

    expect(reading).toMatchObject({
      kind: "answered",
      answer: {
        approved: true,
        overrideArguments: {
          supplier: "Acme",
          itemDescription: "40 office chairs",
          amountUsd: 500,
        },
      },
    });
  });

  it("'🤷' is not understood: no answer, never a refusal", async () => {
    const reading = await readByModel(interpreter, { ask, reply: "🤷" }, site());

    expect(reading.kind).toBe("declined");
    expect(reading).toHaveProperty(
      "reason",
      expect.stringContaining("the reply does not answer the question"),
    );
  });
});
