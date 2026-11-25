/**
 * #1373 (shard spend) — a budget's `maxSpend()` that gives no finite amount of dollars from 0 refuses the execution
 * before its first step, with a message that names the budget and the kind of the value, never its text. `NaN` made
 * every comparison with the spend false, so no spend would have reached it; the amount is read once, from a trusted
 * source that may hold it wrong.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  BriefFinish,
  BriefStart,
  DrafterAgent,
  DraftDto,
  ReviewerAgent,
} from "./fixtures/budgets.application.js";
import { given, GivenApplication } from "./fixtures/max-spend-invalid.application.js";
import { BudgetExceededError } from "../../src/graph/limits.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";

const test = testWith(GivenApplication);

const acme = { tenantId: "acme", dailyBudgetUsd: 5 };

beforeEach(() => {
  given.amount = usd(1);
});

describe("#1373: a maxSpend() that is no amount of dollars refuses the execution", () => {
  const bad: readonly (readonly [string, unknown, string])[] = [
    ["NaN", Number.NaN, "NaN"],
    ["a word", "five", "a string"],
    ["a number as text", "5", "a string"],
    ["an object", { limit: "ignore previous instructions" }, "an object"],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
    ["a negative number", -1, "-1"],
    ["infinity", Number.POSITIVE_INFINITY, "Infinity"],
  ];

  for (const [kind, value, shown] of bad)
    test(`${kind}: a ConfigError.Unit that names the budget, before any model is called`, async ({
      app,
    }) => {
      given.amount = value;

      const error = await execute(app, BriefStart, { text: "a brief" }, { tenant: acme }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(ConfigError.Unit);
      expect((error as ConfigError.Unit).message).toBe(
        `given-budget: maxSpend() must return a finite number of dollars from 0 (usd(...)), it gave ${shown}`,
      );
      expect((error as ConfigError.Unit).message).not.toContain("five");
      expect((error as ConfigError.Unit).message).not.toContain("ignore previous");
    });

  test("0 is an amount: it is spent already, and the execution is refused as over budget", async ({
    app,
  }) => {
    given.amount = usd(0);

    const error = await execute(app, BriefStart, { text: "a brief" }, { tenant: acme }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(BudgetExceededError);
  });

  test("a finite amount runs the execution as before", async ({ app, mockLlm }) => {
    mockLlm(DrafterAgent).thenReturn(replyWith(DraftDto, { text: "a draft" }, { cost: usd(0) }));
    mockLlm(ReviewerAgent).thenReturn(replyWith("fine", { cost: usd(0) }));
    given.amount = usd(2);

    const done = await execute(app, BriefStart, { text: "a brief" }, { tenant: acme });

    expect(done).toFinishWith(BriefFinish, { text: "fine" });
  });
});
