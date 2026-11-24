import { describe, expect, it } from "vitest";
import { BudgetExceededError } from "../../../src/index.js";
import { CostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import { CostSource } from "../../../src/finops/cost-source.js";
import { ModelFailure, ModelProviderFailureError } from "../../../src/models/index.js";
import { partialUsageRecordOf } from "../../../src/finops/partial-usage.js";
import { usd } from "../../../src/units/index.js";
import { partialSpendOf, withPartialSpend } from "../../../src/models/transport/stream-partial.js";
import { BudgetScope } from "../../../src/budgets/budget.js";
import { counterOf, type ExecutionBudgetRecord } from "../../../src/budgets/execution-budgets.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import type { App } from "../../../src/app/types.js";
import type { Class } from "../../../src/components/injection.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { transportApp } from "../transport/transport-app.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import {
  ScriptedStreamClient,
  StreamSdkClient,
  failingAfter,
  type StreamScript,
} from "./transport-streaming.fixture.js";
import {
  PartialSpendApplication,
  PartialSpendTightApplication,
} from "./stream-partial-spend.fixture.js";

/**
 * #1399: a stream that fails mid-way charges what it used. Its usage as the provider reported it,
 * else counted from the chunks that came, reaches the ledger with its cost and every budget as a
 * completed call's does, and the error is the stream's own failure.
 */

async function appOn(application: Class, script: StreamScript): Promise<App> {
  return transportApp(application, {
    client: new ScriptedBedrockClient([]),
    clock: new VirtualClock(),
    overrides: new Map([[StreamSdkClient, new ScriptedStreamClient([script])]]),
  });
}

const failure = (): Error => new ModelProviderFailureError({ failure: ModelFailure.ServerError });

/** What the run's error carries as the loop's spend. */
async function failedWith(app: App): Promise<{ error: unknown; usage: readonly unknown[] }> {
  const error: unknown = await execute(
    app,
    ChatStart,
    { text: "hi" },
    { onStream: () => undefined },
  ).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  const usage: unknown = error instanceof Error ? Reflect.get(error, "usage") : undefined;
  return { error, usage: Array.isArray(usage) ? usage : [] };
}

const chainHas = (error: unknown, cls: abstract new (...args: never[]) => Error): boolean => {
  let cause: unknown = error;
  while (cause instanceof Error) {
    if (Object.prototype.isPrototypeOf.call(cls.prototype, cause)) return true;
    cause = cause.cause;
  }
  return false;
};

describe(
  "#1399: a stream that fails mid-way charges its partial usage",
  { timeout: 30_000 },
  () => {
    it("a failure after chunks, with the provider's usage: that usage, priced, is the call's spend", async () => {
      const app = await appOn(PartialSpendApplication, failingAfter(["Hel", "lo"], failure()));

      const { error, usage } = await failedWith(app);

      expect(chainHas(error, ModelProviderFailureError)).toBe(true); // the original failure
      expect(usage).toEqual([
        expect.objectContaining({
          inputTokens: 100,
          outputTokens: 50,
          costSource: CostSource.PriceTable,
        }),
      ]);
      await app.close();
    });

    it("the spend is in the ledger, not only in the error", async () => {
      const app = await appOn(PartialSpendApplication, failingAfter(["Hel"], failure()));

      await failedWith(app);

      const ledger = app.resolve(CostLedgerRepository);
      const record: ExecutionBudgetRecord = {
        budget: { name: "test-execution-budget" },
        scope: BudgetScope.Execution,
        key: "execution-1",
        maxSpend: 0,
      };
      const spent = await ledger.findUsageByCounter(counterOf(record, new Date(0)));
      expect(spent.tokens).toBe(150);
      await app.close();
    });

    it("a failure without the provider's usage: counted from the chunks that came", async () => {
      const app = await appOn(
        PartialSpendApplication,
        failingAfter(["abcd", "efgh"], failure(), "rejects"),
      );

      const { error, usage } = await failedWith(app);

      expect(chainHas(error, ModelProviderFailureError)).toBe(true);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toEqual(
        expect.objectContaining({ outputTokens: 2, costSource: CostSource.PriceTable }),
      );
      expect((usage[0] as { inputTokens: number }).inputTokens).toBeGreaterThan(0);
      await app.close();
    });

    it("a partial spend that crosses a budget is checked against it: the next execution is refused", async () => {
      const app = await appOn(PartialSpendTightApplication, failingAfter(["Hel"], failure()));

      const first = await failedWith(app);
      const second = await execute(app, ChatStart, { text: "again" }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(chainHas(first.error, ModelProviderFailureError)).toBe(true);
      expect(chainHas(first.error, BudgetExceededError)).toBe(false); // the error stays the stream's own
      expect(second).toBeInstanceOf(BudgetExceededError);
      await app.close();
    });
  },
);

describe("#1399: partial spend, as the error carries it", () => {
  const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it("is read from the error or one of its causes", () => {
    const inner = withPartialSpend(new Error("inner"), { usage });
    expect(partialSpendOf(inner)?.usage).toEqual(usage);
    expect(partialSpendOf(new Error("outer", { cause: inner }))?.usage).toEqual(usage);
    expect(partialSpendOf(new Error("none"))).toBeUndefined();
    expect(partialSpendOf("text")).toBeUndefined();
  });

  it("a thrown non-object is wrapped, so the spend is never dropped", () => {
    const carrier = withPartialSpend("boom", { usage });
    expect(partialSpendOf(carrier)?.usage).toEqual(usage);
  });
});

describe("#1399: the record of a partial spend", () => {
  const call = { requestChars: 40, answerChars: 9 };
  const priced = { model: "m", price: { inputPerMTok: 1, outputPerMTok: 2 } };

  it("a call that cannot be priced is unpriced tokens, never dropped", () => {
    const error = withPartialSpend(new Error("x"), {
      usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(partialUsageRecordOf("agent", { model: "m" }, error, call)).toEqual(
      expect.objectContaining({
        inputTokens: 7,
        outputTokens: 3,
        costUsd: 0,
        costSource: CostSource.Unpriced,
      }),
    );
  });

  it("the cost the provider reported is the call's (api)", () => {
    const error = withPartialSpend(new Error("x"), {
      usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: usd(0.5),
    });
    expect(partialUsageRecordOf("agent", { model: "m" }, error, call)).toEqual(
      expect.objectContaining({ costUsd: 0.5, costSource: CostSource.Api }),
    );
  });

  it("without a report it is counted from the chunks: 4 characters a token, rounded up", () => {
    expect(partialUsageRecordOf("agent", priced, new Error("x"), call)).toEqual(
      expect.objectContaining({
        inputTokens: 10,
        outputTokens: 3,
        costSource: CostSource.PriceTable,
      }),
    );
  });

  it("nothing came and nothing was reported: no record", () => {
    expect(
      partialUsageRecordOf("agent", priced, new Error("x"), { requestChars: 40, answerChars: 0 }),
    ).toBeUndefined();
  });
});
