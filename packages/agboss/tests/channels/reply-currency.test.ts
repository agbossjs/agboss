/**
 * #688 — a change of the call in a currency the call is not in is no answer, whatever the model
 * made of it: "yes, up to €900" on a call in US dollars would need converting, a guess. The call's
 * currency comes from its fields (a name like `amountUsd` or `amount_usd`, a description saying "US
 * dollars"); the reply's from its signs and words, in any language. Dollars written any way are
 * dollars; a reply naming no currency, a call naming none, a refusal and an approval as asked are
 * left as the model read them.
 */
import { describe, expect, it } from "vitest";
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
      currencyMismatchOf("yes, up to 900 — see the details, pencils, franchise, Euripides", OrderInDollarsDto),
    ).toBeUndefined();
  });
});

describe("#688: what the guard does to a reading", () => {
  const interpreter = {
    approves: OrderInDollarsDto,
    answer: ToolCallApprovalDecisionDto,
  } as unknown as AssembledReplyInterpreter;
  const capped: ModelReading = {
    kind: "answered",
    answer: { approved: true, overrideArguments: { supplier: "Acme", amountUsd: 900 } },
    usage: [],
  };

  it("a capped approval in euros becomes not understood, its spend kept", () => {
    const read = withinCurrency(capped, interpreter, "yes, up to €900");

    expect(read).toMatchObject({ kind: "declined", usage: [] });
    expect(read).toHaveProperty("reason", expect.stringContaining("the reply does not answer the question"));
  });

  it("a refusal and an approval as asked stay as read, whatever currency the reply names", () => {
    const refused: ModelReading = { kind: "answered", answer: { approved: false, reason: "no" }, usage: [] };
    const asAsked: ModelReading = { kind: "answered", answer: { approved: true }, usage: [] };

    expect(withinCurrency(refused, interpreter, "no, not even 900 euros")).toBe(refused);
    expect(withinCurrency(asAsked, interpreter, "yes, fine in €")).toBe(asAsked);
  });

  it("a capped approval in dollars stays as read", () => {
    expect(withinCurrency(capped, interpreter, "yes, up to $900")).toBe(capped);
  });
});
