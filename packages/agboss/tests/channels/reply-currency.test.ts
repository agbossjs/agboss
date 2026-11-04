/**
 * #688 — an approval in a currency the call is not in is no answer, whatever the model made of it:
 * "yes, up to €900" on a call in US dollars would need converting, a guess. Fail closed by
 * construction (security review): the call's currency comes from its fields (a name like
 * `amountUsd` / `amount_usd`, a description saying "US dollars"); any currency signal in the reply
 * that is not it — a currency symbol, a `<letters>$` but `US$`, an ISO 4217 code in any case, a
 * currency word in several languages — makes the reply not understood, wherever it stands; and the
 * model's own `currency` must be the call's, or `unspecified` when the reply names none. A call
 * naming no currency and a refusal are left as the model read them.
 */
import { AIMessage } from "@langchain/core/messages";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { currencySignalsOf } from "../../src/channels/currency-signals.js";
import type { AssembledReplyInterpreter } from "../../src/channels/discovery.js";
import { currencyMismatchOf, withinCurrency } from "../../src/channels/reply-currency.js";
import type { ModelReading } from "../../src/channels/reply-reader.js";
import { readByModel } from "../../src/channels/reply-reader.js";
import { Integer, Text } from "../../src/dto/index.js";
import { ToolCallApprovalDecisionDto } from "../../src/dto/standard/framework.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { seededProperties } from "../helpers/property-seed.js";

seededProperties("reply-currency.test.ts");

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

/** Replies in US dollars, or naming no currency. */
const IN_DOLLARS = [
  "yes, up to $900",
  "sí, hasta 900 dólares",
  "ja, maximal 900 Dollar",
  "да, но не больше 900 долларов",
  "כן, עד 900 דולר",
  "approved, 900 USD",
  "fine, 900usd",
  "yes, up to US$900",
  "ok, da, ma non più di 900 dollari",
];

/** Signals of another currency, as a reply may write them. */
const FOREIGN = [
  "€500",
  "500 EUR",
  "500 eur",
  "500cad",
  "500 Canadian dollars",
  "five hundred euros",
  "yes, up to €900",
  "ok, max 900 euros",
  "כן, עד 900 שקל",
  '900 ש"ח',
  "да, до 900 евро",
  "fine, 900 NIS at most",
  "up to £900",
  "yes, up to C$900",
  "ok, max CA$900",
  "fine, A$900 at most",
  "up to NZ$900",
  "HK$900 is the limit",
  "up to R$900",
  "max XY$900",
  "yes, Z$ 900",
  "ok, 900 Australian dollars",
  "yes, in CAD",
  "ok, 900 Cad",
  "fine, sek 900",
  "approved up to 900 MXN",
  "ok, 900 CNY",
  "₩900",
  "฿ 900",
  "¥900",
  "up to 900 pesos",
  "900 francs is fine",
  "900 kronor",
  "yes, 900 pounds",
  "nine hundred bucks",
];

describe("#688: the reply's currency against the call's", () => {
  it.each(FOREIGN)("%j on a call in US dollars: another currency, not understood", (reply) => {
    expect(currencyMismatchOf(reply, OrderInDollarsDto, "USD")).toMatch(
      /converting it would be a guess/u,
    );
  });

  it.each(IN_DOLLARS)("%j on a call in US dollars, read as USD: nothing to convert", (reply) => {
    expect(currencyMismatchOf(reply, OrderInDollarsDto, "USD")).toBeUndefined();
  });

  it("a reply naming no currency, read as unspecified or as USD: nothing to convert", () => {
    expect(currencyMismatchOf("ok but max 900", OrderInDollarsDto, "unspecified")).toBeUndefined();
    expect(currencyMismatchOf("ok but max 900", OrderInDollarsDto, "USD")).toBeUndefined();
  });

  it("the model's currency: another one, or unspecified while the reply names one, is not understood", () => {
    expect(currencyMismatchOf("ok but max 900", OrderInDollarsDto, "EUR")).toMatch(
      /reading's currency is EUR/u,
    );
    expect(currencyMismatchOf("yes, up to $900", OrderInDollarsDto, "unspecified")).toMatch(
      /names no currency/u,
    );
  });

  it("the call's currency from a field's name alone: `amount_eur`", () => {
    expect(currencyMismatchOf("yes, up to $900", OrderBySuffixDto, "USD")).toMatch(/USD.*EUR/u);
    expect(currencyMismatchOf("yes, up to €900", OrderBySuffixDto, "EUR")).toBeUndefined();
  });

  it("a call that names no currency: nothing to compare", () => {
    expect(currencyMismatchOf("yes, up to €9", OrderInCentsDto, "EUR")).toBeUndefined();
  });

  it("no false currency in ordinary words: details, pencils, a franchise, Euripides", () => {
    expect(
      currencySignalsOf("yes, up to 900 — see the details, pencils, franchise, Euripides"),
    ).toEqual([]);
  });

  it("a code that is also a word counts in any case: a false 'not understood' asks again", () => {
    expect(currencyMismatchOf("yes, all good, $900 max", OrderInDollarsDto, "USD")).toMatch(/ALL/u);
  });
});

/** A word of a reply that names no currency. */
const FILLER = fc.constantFrom(
  "yes",
  "ok",
  "fine",
  "approved",
  "up to",
  "max",
  "900",
  "500",
  "да",
  "כן",
  "sí",
);

/** The call's own currency, written any way. */
const DOLLAR = fc.constantFrom(
  "$900",
  "900 dollars",
  "USD 900",
  "900usd",
  "US$900",
  "900 Dollar",
  "долларов",
);

/** A signal of another currency, in any case. */
const FOREIGN_SIGNAL = fc
  .constantFrom(
    "€",
    "£",
    "¥",
    "₪",
    "₩",
    "฿",
    "₹",
    "₽",
    "C$",
    "A$",
    "NZ$",
    "R$",
    "XY$",
    "eur",
    "cad",
    "sek",
    "mxn",
    "cny",
    "gbp",
    "jpy",
    "chf",
    "ils",
    "aud",
    "euros",
    "pesos",
    "francs",
    "pounds",
    "kronor",
    "canadian",
    "australian",
    "евро",
    "שקל",
    "yen",
    "yuan",
  )
  .chain((signal) =>
    fc
      .constantFrom("lower", "upper", "as is")
      .map((form) =>
        form === "lower" ? signal.toLowerCase() : form === "upper" ? signal.toUpperCase() : signal,
      ),
  );

/** What stands between two parts: nothing, a space or several, punctuation. */
const GAP = fc.constantFrom("", " ", "  ", ", ", " — ", "\n");

describe("#688: a reply mixing the call's currency with another is never approved (property)", () => {
  it("any foreign signal, in any position, case or spacing, with the model's currency USD or unspecified", () => {
    fc.assert(
      fc.property(
        fc.array(FILLER, { maxLength: 4 }),
        fc.option(DOLLAR, { nil: undefined }),
        FOREIGN_SIGNAL,
        fc.array(GAP, { minLength: 8, maxLength: 8 }),
        fc.nat(),
        fc.constantFrom("USD", "unspecified"),
        (fillers, dollar, foreign, gaps, at, currency) => {
          const parts = [...fillers, ...(dollar === undefined ? [] : [dollar])];
          parts.splice(at % (parts.length + 1), 0, foreign);
          const reply = parts.reduce((text, part, index) => {
            const gap = gaps[index] ?? " ";
            // letters glued to letters make another word, not a spacing: a space there
            const glued = gap === "" && /\p{L}$/u.test(text) && /^\p{L}/u.test(part);
            return `${text}${glued ? " " : gap}${part}`;
          }, "");
          const approved: ModelReading = {
            kind: "answered",
            answer: { approved: true },
            usage: [],
            currency,
          };

          expect(withinCurrency(approved, purchaseInterpreter, reply)).toMatchObject({
            kind: "declined",
          });
        },
      ),
      { numRuns: 1000 },
    );
  });
});

const purchaseInterpreter: AssembledReplyInterpreter = {
  channel: "purchase-approval-channel",
  interpreter: OrderInDollarsDto,
  name: "purchase-reply-interpreter",
  answer: ToolCallApprovalDecisionDto,
  approves: OrderInDollarsDto,
  model: "test/interpreter",
  instructions: "Read the reply.",
};

describe("#688: what the guard does to a reading", () => {
  const capped: ModelReading = {
    kind: "answered",
    answer: { approved: true, overrideArguments: { supplier: "Acme", amountUsd: 900 } },
    usage: [],
    currency: "USD",
  };

  it("a capped approval in euros becomes not understood, its spend kept", () => {
    const read = withinCurrency(capped, purchaseInterpreter, "yes, up to €900");

    expect(read).toMatchObject({ kind: "declined", usage: [] });
    expect(read).toHaveProperty(
      "reason",
      expect.stringContaining("the reply does not answer the question"),
    );
  });

  it("a refusal stays as read, whatever currency the reply names", () => {
    const refused: ModelReading = {
      kind: "answered",
      answer: { approved: false, reason: "no" },
      usage: [],
    };

    expect(withinCurrency(refused, purchaseInterpreter, "no, not even 900 euros")).toBe(refused);
  });

  it.each(["yes, fine in €", "yes, in CAD", "ok, pay it in Canadian dollars"])(
    "an approval as asked, no correction, %j: not understood",
    (reply) => {
      const asAsked: ModelReading = { kind: "answered", answer: { approved: true }, usage: [] };

      expect(withinCurrency(asAsked, purchaseInterpreter, reply)).toMatchObject({
        kind: "declined",
      });
    },
  );

  it("an approval with no currency named, or in the call's, stays as read", () => {
    const asAsked: ModelReading = { kind: "answered", answer: { approved: true }, usage: [] };

    expect(withinCurrency(asAsked, purchaseInterpreter, "yes")).toBe(asAsked);
    expect(withinCurrency(capped, purchaseInterpreter, "yes, up to $900")).toBe(capped);
  });

  it("an answer in the DTO's own shape names no currency: a reply naming one is not understood", () => {
    const unnamed: ModelReading = {
      kind: "answered",
      answer: { approved: true, overrideArguments: { supplier: "Acme", amountUsd: 900 } },
      usage: [],
    };

    expect(withinCurrency(unnamed, purchaseInterpreter, "yes, up to $900")).toMatchObject({
      kind: "declined",
    });
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
  const capped = {
    decision: "approve-with-changes",
    currency: "USD",
    overrideArguments: { amountUsd: 900 },
  };

  it("a capped approval in euros the model approved as USD is not understood", async () => {
    const reading = await readByModel(
      purchaseInterpreter,
      { ask, reply: "yes, up to €900" },
      siteOf(capped),
    );

    expect(reading).toMatchObject({ kind: "declined" });
    expect(reading).toHaveProperty("reason", expect.stringContaining("EUR"));
  });

  it("a plain approve on 'yes, in CAD' is not understood, the call not approved", async () => {
    const reading = await readByModel(
      purchaseInterpreter,
      { ask, reply: "yes, in CAD" },
      siteOf({ decision: "approve", currency: "CAD" }),
    );

    expect(reading).toMatchObject({ kind: "declined" });
    expect(reading).toHaveProperty("reason", expect.stringContaining("CAD"));
  });

  it("the model's currency other than the call's, on a reply naming none, is not understood", async () => {
    const reading = await readByModel(
      purchaseInterpreter,
      { ask, reply: "ok but max 900" },
      siteOf({ ...capped, currency: "EUR" }),
    );

    expect(reading).toMatchObject({ kind: "declined" });
  });

  it.each([
    [
      "no currency at all",
      { decision: "approve-with-changes", overrideArguments: { amountUsd: 900 } },
    ],
    ["a currency no code names", { ...capped, currency: "dollars" }],
  ])("an answer with %s is no answer, on a reply naming none", async (_what, args) => {
    const reading = await readByModel(
      purchaseInterpreter,
      { ask, reply: "ok but max 900" },
      siteOf(args),
    );

    expect(reading).toMatchObject({ kind: "declined" });
    expect(reading).toHaveProperty(
      "reason",
      expect.stringContaining("names no currency of ISO 4217, nor unspecified"),
    );
  });

  it("the same in dollars is the capped approval", async () => {
    const reading = await readByModel(
      purchaseInterpreter,
      { ask, reply: "yes, up to $900" },
      siteOf(capped),
    );

    expect(reading).toMatchObject({
      kind: "answered",
      answer: { approved: true, overrideArguments: { supplier: "Acme", amountUsd: 900 } },
    });
  });
});
