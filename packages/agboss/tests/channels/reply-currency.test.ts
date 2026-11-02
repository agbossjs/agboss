/**
 * #688 — a change of the call in a currency the call is not in is no answer, whatever the model
 * made of it: "yes, up to €900" on a call in US dollars would need converting, a guess. The call's
 * currency comes from its fields (a name like `amountUsd` or `amount_usd`, a description saying "US
 * dollars"); the reply's from its signs and words, in any language. Dollars written any way are
 * dollars; a reply naming no currency, a call naming none, a refusal and an approval as asked are
 * left as the model read them.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { readByModel } from "../../src/channels/reply-reader.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import type { AssembledReplyInterpreter } from "../../src/channels/discovery.js";
import { currencyMismatchOf, withinCurrency } from "../../src/channels/reply-currency.js";
import type { ModelReading } from "../../src/channels/reply-reader.js";
import { Integer, Text } from "../../src/dto/index.js";
import { ToolCallApprovalDecisionDto } from "../../src/dto/standard/framework.js";

class OrderInDollarsDto {
  @Text({ prompt: "the supplier" })
  supplier!: string;

  @Integer({ prompt: "the amount to order, in whole US dollars", min: 1 })
  amountUsd!: number;
}

class OrderBySuffixDto {
  @Integer({ prompt: "the amount", min: 1 })
  amount_eur!: number;
}

class OrderInCentsDto {
  @Integer({ prompt: "the amount in cents", min: 1 })
  amountCents!: number;
}

describe("#688: the reply's currency against the call's", () => {
  it.each([
    "yes, up to €900",
    "ok, max 900 euros",
    "כן, עד 900 שקל",
    "да, до 900 евро",
    "fine, 900 NIS at most",
    "up to £900",
  ])("%j on a call in US dollars: converting would be a guess", (reply) => {
    expect(currencyMismatchOf(reply, OrderInDollarsDto)).toMatch(/converting it would be a guess/u);
  });

  it.each([
    "yes, up to $900",
    "ok but max 900",
    "sí, hasta 900 dólares",
    "ja, maximal 900 Dollar",
    "да, но не больше 900 долларов",
    "כן, עד 900 דולר",
    "approved, 900 USD",
  ])("%j on a call in US dollars: nothing to convert", (reply) => {
    expect(currencyMismatchOf(reply, OrderInDollarsDto)).toBeUndefined();
  });

  it("the call's currency from a field's name alone: `amount_eur`", () => {
    expect(currencyMismatchOf("yes, up to $900", OrderBySuffixDto)).toMatch(/USD.*EUR/u);
    expect(currencyMismatchOf("yes, up to €900", OrderBySuffixDto)).toBeUndefined();
  });

  it("a call that names no currency: nothing to compare", () => {
    expect(currencyMismatchOf("yes, up to €9", OrderInCentsDto)).toBeUndefined();
  });

  it("no false currency in ordinary words: details, pencils, a franchise, Euripides", () => {
    expect(
      currencyMismatchOf(
        "yes, up to 900 — see the details, pencils, franchise, Euripides",
        OrderInDollarsDto,
      ),
    ).toBeUndefined();
  });
});

describe("#688: what the guard does to a reading", () => {
  const interpreter: AssembledReplyInterpreter = {
    channel: "purchase-approval-channel",
    interpreter: OrderInDollarsDto,
    name: "purchase-reply-interpreter",
    answer: ToolCallApprovalDecisionDto,
    approves: OrderInDollarsDto,
    model: "test/interpreter",
    instructions: "Read the reply.",
  };
  const capped: ModelReading = {
    kind: "answered",
    answer: { approved: true, overrideArguments: { supplier: "Acme", amountUsd: 900 } },
    usage: [],
  };

  it("a capped approval in euros becomes not understood, its spend kept", () => {
    const read = withinCurrency(capped, interpreter, "yes, up to €900");

    expect(read).toMatchObject({ kind: "declined", usage: [] });
    expect(read).toHaveProperty(
      "reason",
      expect.stringContaining("the reply does not answer the question"),
    );
  });

  it("a refusal and an approval as asked stay as read, whatever currency the reply names", () => {
    const refused: ModelReading = {
      kind: "answered",
      answer: { approved: false, reason: "no" },
      usage: [],
    };
    const asAsked: ModelReading = { kind: "answered", answer: { approved: true }, usage: [] };

    expect(withinCurrency(refused, interpreter, "no, not even 900 euros")).toBe(refused);
    expect(withinCurrency(asAsked, interpreter, "yes, fine in €")).toBe(asAsked);
  });

  it("a capped approval in dollars stays as read", () => {
    expect(withinCurrency(capped, interpreter, "yes, up to $900")).toBe(capped);
  });
});

describe("#688: the guard on a model interpreter's reading", () => {
  /** A chat model that answers every call with the one move given. */
  const answering = (args: Readonly<Record<string, unknown>>) =>
    ({
      bindTools: () => ({
        invoke: () =>
          Promise.resolve(
            new AIMessage({
              content: "",
              tool_calls: [{ id: "c1", name: "answer-tool-call-approval-decision-dto", args }],
              usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            }),
          ),
      }),
    }) as never;
  const interpreter: AssembledReplyInterpreter = {
    channel: "purchase-approval-channel",
    interpreter: OrderInDollarsDto,
    name: "purchase-reply-interpreter",
    answer: ToolCallApprovalDecisionDto,
    approves: OrderInDollarsDto,
    model: "test/interpreter",
    instructions: "Read the reply.",
  };
  const ask = { tool: "order-tool", arguments: { supplier: "Acme", amountUsd: 1200 } };
  const siteOf = (args: Readonly<Record<string, unknown>>) => ({
    gateway: { chatModel: () => answering(args) } as never,
    settings: {
      model: "test/interpreter",
      temperature: 0,
      maxTokens: 100,
      price: { inputPerMTok: 1, outputPerMTok: 1 },
    },
    callbacks: [],
    pii: { policies: new PiiPolicySet([], ""), known: {} },
  });

  it("a capped approval in euros the model approved is not understood", async () => {
    const capped = { decision: "approve-with-changes", overrideArguments: { amountUsd: 900 } };

    const reading = await readByModel(
      interpreter,
      { ask, reply: "yes, up to €900" },
      siteOf(capped),
    );

    expect(reading).toMatchObject({ kind: "declined" });
    expect(reading).toHaveProperty("reason", expect.stringContaining("EUR"));
  });

  it("the same in dollars is the capped approval", async () => {
    const capped = { decision: "approve-with-changes", overrideArguments: { amountUsd: 900 } };

    const reading = await readByModel(
      interpreter,
      { ask, reply: "yes, up to $900" },
      siteOf(capped),
    );

    expect(reading).toMatchObject({
      kind: "answered",
      answer: { approved: true, overrideArguments: { supplier: "Acme", amountUsd: 900 } },
    });
  });
});
