/**
 * #1356 — what a paid service that is no model leaves in the cost report (#280 S43), the price table of a
 * provider's cost and the usage a state's checkpoint keeps: each read on its own.
 */
import { emptyCheckpoint, type CheckpointTuple } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { withUsageRead, withUsageReadOf } from "../../src/app/restored-usage.js";
import { CostSource, ZERO_USAGE, NO_PROVIDER } from "../../src/finops/usage.js";
import { LedgerState } from "../../src/finops/ledger-mark.js";
import { costLabel, ModelCost, priceOf } from "../../src/models/cost.js";
import {
  LiveSpendRecorder,
  SpendOutsideStepError,
  serviceUsageOf,
} from "../../src/components/spend-recorder.js";
import { usd } from "../../src/units/index.js";

describe("#1356: the record of a service's spend", () => {
  it("bills the service as caller and model, at its cost, with no tokens", () => {
    expect(serviceUsageOf({ service: "serp-api", cost: usd(0.002) })).toStrictEqual({
      caller: "service:serp-api",
      model: "serp-api",
      provider: NO_PROVIDER,
      ...ZERO_USAGE,
      costUsd: usd(0.002),
      costSource: CostSource.Tool,
    });
  });

  it("outside a step the recorder refuses, naming its consumer and the service", () => {
    const recorder = new LiveSpendRecorder("refund-tool");

    expect(() => {
      recorder.record({ service: "serp-api", cost: usd(0.002) });
    }).toThrow(SpendOutsideStepError);
    expect(() => {
      recorder.record({ service: "serp-api", cost: usd(0.002) });
    }).toThrow(
      "[spend.outside-step] refund-tool recorded serp-api spend outside a step or a tool call — record it while the step (or the tool call) runs",
    );
  });

  it("is a named error with its code, and a recorder nobody can change", () => {
    const error = new SpendOutsideStepError({ message: "no step" });

    expect(error.name).toBe("SpendOutsideStepError");
    expect(error.code).toBe("spend.outside-step");
    expect(error.message).toBe("no step");
    expect(Object.isFrozen(new LiveSpendRecorder("tool"))).toBe(true);
  });
});

describe("#1356: where a provider's cost comes from", () => {
  const prices = { "local/llama": { inputPerMillion: usd(1), outputPerMillion: usd(2) } };

  it("a response's cost has no price table, and reads as such", () => {
    const cost = ModelCost.fromResponse();

    expect(cost).toEqual({ kind: "from-response" });
    expect(Object.isFrozen(cost)).toBe(true);
    expect(priceOf(cost, "local/llama")).toBeUndefined();
    expect(costLabel(cost)).toBe("cost from the response");
  });

  it("a price table is kept as it was given, frozen, and reads as such", () => {
    const cost = ModelCost.fromPrices(prices);

    expect(cost).toEqual({ kind: "from-prices", prices });
    expect(Object.isFrozen(cost)).toBe(true);
    expect(cost.kind === "from-prices" && Object.isFrozen(cost.prices)).toBe(true);
    expect(costLabel(cost)).toBe("cost from the price table");
  });

  it("the price of a model is its two prices, the cached one only when it has one", () => {
    const cost = ModelCost.fromPrices({
      ...prices,
      "local/cached": {
        inputPerMillion: usd(3),
        outputPerMillion: usd(4),
        cachedInputPerMillion: usd(0.5),
      },
    });

    expect(priceOf(cost, "local/llama")).toStrictEqual({ inputPerMTok: 1, outputPerMTok: 2 });
    expect(priceOf(cost, "local/cached")).toStrictEqual({
      inputPerMTok: 3,
      outputPerMTok: 4,
      cacheReadPerMTok: 0.5,
    });
    expect(priceOf(cost, "other/model")).toBeUndefined();
  });
});

describe("#1356: the usage a checkpoint's tuple gives back", () => {
  const MADE_AT = new Date("2026-11-04T12:00:00.000Z");
  const paid = serviceUsageOf({ service: "serp-api", cost: usd(1) });
  /** A record as a state of before 0.1.1 kept it. */
  const legacy = {
    ...paid,
    isRecordedElsewhere: true,
    ledgerId: "p:1",
    madeAt: MADE_AT.toISOString(),
  };
  const written = {
    ...paid,
    ledger: { state: LedgerState.Written, ledgerId: "p:1", madeAt: MADE_AT },
  };

  const tupleOf = (
    values: Record<string, unknown>,
    pendingWrites?: CheckpointTuple["pendingWrites"],
  ): CheckpointTuple => ({
    config: { configurable: { thread_id: "t", checkpoint_ns: "" } },
    checkpoint: { ...emptyCheckpoint(), channel_values: values },
    ...(pendingWrites === undefined ? {} : { pendingWrites }),
  });

  it("reads each record of the usage channel; what is no record is left as it is", () => {
    const read = withUsageRead(
      tupleOf({ usage: [legacy, null, "text", 5, paid], other: [legacy] }),
    );

    expect(read.checkpoint.channel_values.usage).toEqual([written, null, "text", 5, paid]);
    expect(read.checkpoint.channel_values.other).toEqual([legacy]);
  });

  it("leaves a usage that is no list, and a checkpoint with none, as they are", () => {
    expect(withUsageRead(tupleOf({ usage: "none" })).checkpoint.channel_values).toEqual({
      usage: "none",
    });
    const noUsage = tupleOf({ other: 1 });
    expect(withUsageRead(noUsage).checkpoint.channel_values).toBe(
      noUsage.checkpoint.channel_values,
    );
  });

  it("reads the pending writes to the usage channel, and has none without them", () => {
    const withWrites = withUsageRead(
      tupleOf({}, [
        ["task-1", "usage", [legacy]],
        ["task-1", "other", [legacy]],
      ]),
    );
    const without = withUsageRead(tupleOf({ usage: [] }));

    expect(withWrites.pendingWrites).toEqual([
      ["task-1", "usage", [written]],
      ["task-1", "other", [legacy]],
    ]);
    expect("pendingWrites" in without).toBe(false);
  });

  it("a tuple that is not there stays not there", () => {
    const tuple = tupleOf({ usage: [legacy] });

    expect(withUsageReadOf(undefined)).toBeUndefined();
    expect(withUsageReadOf(tuple)?.checkpoint.channel_values.usage).toEqual([written]);
  });
});
