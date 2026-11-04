/**
 * #688 (security review) — what a free-text reply may change of the call it approves: only fields
 * the call already has, each the same kind of value, never above the call's own. A nested amount, a
 * field the call does not have, a number written as text or a flag turned on is not understood — a
 * raise or a new field is decided, never read from a reply.
 */
import { describe, expect, it } from "vitest";
import { correctionRefusalOf } from "../../src/channels/reply-correction.js";

const ask = {
  tool: "pay-out-tool",
  arguments: {
    payee: "ann",
    amountCents: 120_000,
    priceText: "1200",
    limits: { perDayCents: 50_000, currency: "usd" },
    split: [60_000, 60_000],
    urgent: false,
    reviewed: true,
  },
};

/** The answer as the reader holds it: the correction laid over the call's own arguments. */
const corrected = (override: Readonly<Record<string, unknown>>) => ({
  approved: true,
  overrideArguments: { ...ask.arguments, ...override },
});

describe("#688: a correction never raises, adds or retypes a field", () => {
  it.each([
    ["a top-level raise", { amountCents: 200_000 }, /raise amountCents/u],
    [
      "a nested raise",
      { limits: { perDayCents: 90_000, currency: "usd" } },
      /raise limits\.perDayCents/u,
    ],
    ["a raise inside a list", { split: [60_000, 90_000] }, /raise split\.1/u],
    [
      "a field the call does not have",
      { bonusCents: 1 },
      /bonusCents.*the call has no such field/u,
    ],
    [
      "a nested field the call does not have",
      { limits: { perDayCents: 50_000, currency: "usd", perWeekCents: 1 } },
      /limits\.perWeekCents.*the call has no such field/u,
    ],
    [
      "a number written as text",
      { amountCents: "90000" },
      /amountCents.*not the call's kind of value/u,
    ],
    ["a number where the call has text", { payee: 900 }, /payee.*not the call's kind of value/u],
    ["a numeric text where the call's text is none", { payee: "900" }, /payee.*a number/u],
    ["a numeric text raised", { priceText: "1500" }, /raise priceText/u],
    [
      "a word where the call's text is a number",
      { priceText: "lots" },
      /priceText.*not the call's kind of value/u,
    ],
    [
      "an object for a number",
      { amountCents: { value: 1 } },
      /amountCents.*not the call's kind of value/u,
    ],
    ["a list of another length", { split: [60_000] }, /split.*another length/u],
    ["a flag turned on", { urgent: true }, /raise urgent/u],
    ["a null for a value", { amountCents: null }, /amountCents.*not the call's kind of value/u],
    [
      "a number that is none",
      { amountCents: Number.POSITIVE_INFINITY },
      /amountCents.*not a finite number/u,
    ],
  ] as const)("%s: refused", (_what, override, why) => {
    expect(correctionRefusalOf(corrected(override), ask)).toMatch(why);
  });

  it.each([
    ["a top-level cap", { amountCents: 90_000 }],
    ["a nested cap", { limits: { perDayCents: 20_000, currency: "usd" } }],
    ["a cap inside a list", { split: [60_000, 30_000] }],
    ["a numeric text lowered", { priceText: "900" }],
    ["a text changed", { payee: "bob" }],
    ["a flag turned off", { reviewed: false }],
    ["the call as asked", {}],
  ] as const)("%s: kept", (_what, override) => {
    expect(correctionRefusalOf(corrected(override), ask)).toBeUndefined();
  });

  it("no correction, or a call with no arguments and no correction: nothing to refuse", () => {
    expect(correctionRefusalOf({ approved: true }, ask)).toBeUndefined();
    expect(correctionRefusalOf({ approved: false }, { tool: "t" })).toBeUndefined();
  });

  it("a correction of a call whose arguments are unknown: refused", () => {
    expect(
      correctionRefusalOf({ approved: true, overrideArguments: { amountCents: 1 } }, { tool: "t" }),
    ).toMatch(/amountCents.*the call has no such field/u);
  });
});
