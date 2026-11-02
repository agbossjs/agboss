/**
 * #688 AC2 — a chat-model reply interpreter with only its one-line prompt, on cheap real models,
 * reads capped approvals in many phrasings, currencies and languages as approvals with the amount
 * set to the cap, a refusal as a refusal, and anything ambiguous as not understood — never an
 * approval it was not given. The call asks $1,200 (example 10's order). Real models via OpenRouter:
 * only `make smoke`, skipped without a key, never in CI. `AGBOSS_SMOKE_REPLY_MODELS` lists the
 * models (comma-separated), by default `openai/gpt-4.1-nano` and `openai/gpt-4o-mini`.
 */
import { describe, expect, it } from "vitest";
import type { AssembledReplyInterpreter } from "../../src/channels/discovery.js";
import { readByModel, type ModelReading } from "../../src/channels/reply-reader.js";
import { Integer, Text } from "../../src/dto/index.js";
import { ToolCallApprovalDecisionDto } from "../../src/dto/standard/framework.js";
import { resolveEnvironment } from "../../src/environments/resolve.js";
import { secret } from "../../src/environments/secret.js";
import { createProviderGateway } from "../../src/llm/gateway.js";
import { ModelProviderDirectory, OpenRouterModelProvider } from "../../src/models/index.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { instanceCalls } from "../models/gateway.js";

const MODELS = (process.env.AGBOSS_SMOKE_REPLY_MODELS ?? "openai/gpt-4.1-nano,openai/gpt-4o-mini")
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model !== "");

class PlacePurchaseOrderDto {
  @Text({ prompt: "the supplier" })
  supplier!: string;

  @Text({ prompt: "what is bought, in one line" })
  itemDescription!: string;

  @Integer({ prompt: "the amount to order, in whole US dollars", min: 1 })
  amountUsd!: number;
}

const interpreterOn = (model: string): AssembledReplyInterpreter => ({
  channel: "purchase-approval-channel",
  interpreter: PlacePurchaseOrderDto, // its class is not read on this path
  name: "purchase-reply-interpreter",
  answer: ToolCallApprovalDecisionDto,
  approves: PlacePurchaseOrderDto,
  model,
  instructions: "Read the approver's reply to the purchase order.",
});

const ask = {
  callId: "call-1",
  tool: "place-purchase-order-tool",
  arguments: { supplier: "Northwind", itemDescription: "6 developer laptops", amountUsd: 1200 },
  summary: "Order 6 developer laptops from Northwind for $1200",
};

/** A capped approval: approved, the amount set to the cap, the rest of the call as it was. */
const CAPPED: readonly (readonly [string, number])[] = [
  ["yes, up to $900", 900],
  ["ok but max 900", 900],
  ["Approved, but no more than 900 dollars.", 900],
  ["fine as long as it stays under $1000", 1000],
  ["go ahead, cap it at $750", 750],
  ["yes — limit $800", 800],
  ["sure, 950 max", 950],
  ["да, но не больше 900 долларов", 900],
  ["כן, עד 900 דולר", 900],
  ["sí, hasta 900 dólares", 900],
  ["ja, maximal 900 Dollar", 900],
];

/** Approved as it is: a plain yes, or a limit at or above what the call asks. */
const AS_ASKED: readonly string[] = ["yes, go ahead", "approved, up to $2000 is fine", "ok"];

/** A refusal: approved false. */
const REFUSED: readonly string[] = ["no, we are not buying laptops this quarter", "нет"];

/** Ambiguous, or a cap in another currency than the call's: not understood, never an approval. */
const UNCLEAR: readonly string[] = [
  "🤷",
  "maybe, let me think about it",
  "what is this for?",
  "yes, up to €900",
  "כן, עד 900 שקל",
];

function siteOf(model: string) {
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
  const settings = { model, temperature: 0, maxTokens: 300 };
  const pii = { policies: new PiiPolicySet([], ""), known: {} };
  return { gateway, settings, callbacks: [], pii };
}

const spent: number[] = [];
const read = async (model: string, reply: string): Promise<ModelReading> => {
  const reading = await readByModel(interpreterOn(model), { ask, reply }, siteOf(model));
  spent.push(...reading.usage.map((record) => record.costUsd));
  process.stderr.write(
    `[${model}] ${JSON.stringify(reply)} → ${JSON.stringify(reading.kind === "answered" ? reading.answer : reading.reason)}\n`,
  );
  return reading;
};

describe.skipIf(!process.env.OPENROUTER_API_KEY)("smoke #688: capped approvals", () => {
  for (const model of MODELS) {
    describe(model, () => {
      for (const [reply, cap] of CAPPED)
        it(`${JSON.stringify(reply)} approves with the amount capped at ${String(cap)}`, async () => {
          const reading = await read(model, reply);

          expect(reading).toMatchObject({
            kind: "answered",
            answer: {
              approved: true,
              overrideArguments: { ...ask.arguments, amountUsd: cap },
            },
          });
        });

      for (const reply of AS_ASKED)
        it(`${JSON.stringify(reply)} approves the call as asked, never a raise`, async () => {
          const reading = await read(model, reply);

          // a raise the model read into the reply is no answer: the framework refuses to read it
          if (reading.kind === "declined") {
            expect(reading.reason).toContain("would raise amountUsd");
            return;
          }
          expect(reading).toMatchObject({ kind: "answered", answer: { approved: true } });
          const answer = (reading as { answer: { overrideArguments?: { amountUsd?: number } } })
            .answer;
          expect(answer.overrideArguments?.amountUsd ?? 1200).toBe(1200);
        });

      for (const reply of REFUSED)
        it(`${JSON.stringify(reply)} is a refusal`, async () => {
          const reading = await read(model, reply);

          expect(reading).toMatchObject({ kind: "answered", answer: { approved: false } });
        });

      for (const reply of UNCLEAR)
        it(`${JSON.stringify(reply)} is not understood, never an approval`, async () => {
          const reading = await read(model, reply);

          expect(reading.kind).toBe("declined");
        });
    });
  }

  it("spends little", () => {
    const total = spent.reduce((sum, cost) => sum + cost, 0);
    process.stderr.write(`[#688 smoke] ${String(spent.length)} calls, $${total.toFixed(6)}\n`);
    expect(total).toBeLessThan(0.05);
  });
});
