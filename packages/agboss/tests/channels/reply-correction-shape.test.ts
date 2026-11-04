/**
 * #688 (security review, structural) — a reply's correction keeps the shape of the call it
 * approves: no new key at any depth, no other kind of value, no list of another length; nested
 * objects are laid over the call's at every depth. And every decision's `overrideArguments` passes
 * the tool's own input strictly: a key the input does not have, at any depth, is refused, never
 * dropped. What the values may be is that validation's; a limit such as "never above the call's
 * amount" is a guardrail's or the tool's own (the payout interceptor test in
 * `reply-capped-approvals.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validDecisionOf } from "../../src/channels/decision.js";
import { withCorrectedCall } from "../../src/channels/reply-tools.js";
import { DtoValidationError } from "../../src/dto/errors.js";
import { defineTool } from "../../src/tools/index.js";

/** The approved call: a payee, an amount, limits nested two deep, a split. */
const ask = {
  tool: "pay-out-tool",
  arguments: {
    payee: "ann",
    amountCents: 120_000,
    limits: { perDayCents: 50_000, window: { days: 7, label: "week" } },
    split: [60_000, 60_000],
  },
};

const correctionOf = (overrideArguments: unknown) =>
  withCorrectedCall({ decision: "approve-with-changes", overrideArguments }, ask);

describe("#688: a correction keeps the call's shape, at every depth", () => {
  it.each([
    ["a new key at depth 1", { tip: 1 }, /tip: the call has no such field/u],
    [
      "a new key at depth 2",
      { limits: { perWeekCents: 1 } },
      /limits\.perWeekCents: the call has no such field/u,
    ],
    [
      "a new key at depth 3",
      { limits: { window: { hours: 1 } } },
      /limits\.window\.hours: the call has no such field/u,
    ],
    ["another kind at depth 1", { amountCents: "90000" }, /amountCents is not the call's kind/u],
    [
      "another kind at depth 2",
      { limits: { perDayCents: "5" } },
      /limits\.perDayCents is not the call's kind/u,
    ],
    [
      "another kind at depth 3",
      { limits: { window: { days: "3" } } },
      /limits\.window\.days is not the call's kind/u,
    ],
    [
      "an object for a number",
      { amountCents: { value: 1 } },
      /amountCents is not the call's kind/u,
    ],
    ["a list for an object", { limits: [1] }, /limits is not the call's kind/u],
    ["null for a value", { payee: null }, /payee is not the call's kind/u],
    ["a list of another length", { split: [60_000] }, /split is a list of another length/u],
    [
      "another kind inside a list",
      { split: [60_000, { a: 1 }] },
      /split\.1 is not the call's kind/u,
    ],
    ["no object at all", 5, /an approval with changes that changes nothing/u],
  ] as const)("%s: no answer", (_what, override, why) => {
    const read = correctionOf(override);

    expect(read.kind).toBe("invalid");
    expect(read).toHaveProperty("reason", expect.stringMatching(why));
  });

  it("a DTO-shaped answer whose correction is no object: no answer", () => {
    expect(withCorrectedCall({ approved: true, overrideArguments: 5 }, ask)).toEqual({
      kind: "invalid",
      reason: "its correction changes the call's shape: it is not the call's arguments",
    });
  });

  it("a change at depth 3 is laid over the call: every other field at every depth kept", () => {
    const read = correctionOf({ limits: { window: { days: 3 } } });

    expect(read).toEqual({
      kind: "answer",
      answer: {
        approved: true,
        overrideArguments: {
          payee: "ann",
          amountCents: 120_000,
          limits: { perDayCents: 50_000, window: { days: 3, label: "week" } },
          split: [60_000, 60_000],
        },
      },
    });
  });

  it("a value may change within its kind: what it may be is the tool's own validation", () => {
    const read = correctionOf({ amountCents: 200_000, split: [1, 2] });

    expect(read).toMatchObject({
      kind: "answer",
      answer: { overrideArguments: { amountCents: 200_000, split: [1, 2] } },
    });
  });
});

const payOutTool = defineTool({
  name: "pay-out-tool",
  description: "Pays a payee",
  input: z.object({
    payee: z.string(),
    amountCents: z.number().int().min(1),
    limits: z.object({
      perDayCents: z.number().int(),
      window: z.object({ days: z.number().int(), label: z.string() }),
    }),
    split: z.array(z.number().int()),
  }),
  output: z.object({}),
  run: () => Promise.resolve({}),
});

const approvedWith = (overrideArguments: unknown) => ({ approved: true, overrideArguments });

describe("#688: a decision's overrideArguments pass the tool's input strictly", () => {
  it.each([
    ["depth 1", { ...ask.arguments, tip: 1 }, "overrideArguments.tip"],
    [
      "depth 2",
      { ...ask.arguments, limits: { ...ask.arguments.limits, perWeekCents: 1 } },
      "overrideArguments.limits.perWeekCents",
    ],
    [
      "depth 3",
      {
        ...ask.arguments,
        limits: { ...ask.arguments.limits, window: { ...ask.arguments.limits.window, hours: 1 } },
      },
      "overrideArguments.limits.window.hours",
    ],
  ])(
    "a key the tool's input does not have at %s is refused, never dropped",
    (_depth, call, path) => {
      const refused = (() => {
        try {
          validDecisionOf(approvedWith(call), payOutTool);
          return undefined;
        } catch (error) {
          return error;
        }
      })();

      expect(refused).toBeInstanceOf(DtoValidationError);
      expect(refused).toHaveProperty("issues", [
        { path, reason: "is no field of the tool's input" },
      ]);
    },
  );

  it("a key the input does not have inside a list of objects is refused", () => {
    const orderTool = defineTool({
      name: "order-tool",
      description: "Orders lines",
      input: z.object({ lines: z.array(z.object({ sku: z.string(), quantity: z.number() })) }),
      output: z.object({}),
      run: () => Promise.resolve({}),
    });
    const call = {
      lines: [
        { sku: "a", quantity: 1 },
        { sku: "b", quantity: 2, discount: 50 },
      ],
    };

    expect(() => validDecisionOf(approvedWith(call), orderTool)).toThrow(
      /overrideArguments\.lines\[1\]\.discount: is no field of the tool's input/u,
    );
  });

  it("the call's own fields, validated: the decision stands", () => {
    expect(validDecisionOf(approvedWith(ask.arguments), payOutTool)).toMatchObject({
      approved: true,
      overrideArguments: ask.arguments,
    });
  });

  it("a value the tool's input refuses is refused: its validation decides what a value may be", () => {
    expect(() =>
      validDecisionOf(approvedWith({ ...ask.arguments, amountCents: -5 }), payOutTool),
    ).toThrow(DtoValidationError);
  });
});
