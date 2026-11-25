import { PiiError } from "../../src/core/error-families/limit-errors.js";
import { usd } from "../../src/units/index.js";
/**
 * #1366: the spend of the tool task's PII reading — what a detection cost is on the closed result when a block
 * rule refuses it, whether the refusal came from a model the call made or from the result's own check.
 */
import { describe, expect, it } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { closedResult } from "../../src/graph/agent-loop/tool-pii.js";
import { errorRecordOf } from "../../src/core/error-record.js";
import { kilobytes } from "../../src/units/index.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

describe("#1366: a refused tool result keeps what the detection cost", () => {
  it("the refusal of a model the call made carries that model's usage", async () => {
    const spent = [record(0.125, "detector")];
    const cause = new PiiError.Refused({
      piiKind: "card-number",
      refusal: "no cards",
      usage: spent,
    });

    const closed = await closedResult(
      undefined,
      undefined,
      { kind: "error", message: cause.message, cause },
      kilobytes(1),
    );

    expect(closed).toMatchObject({
      refusal: errorRecordOf(cause),
      usage: spent,
      isTruncated: false,
    });
    expect(closed.content).toContain("no cards");
  });

  /** A set whose every search costs a record; `refuses` makes its block rule refuse. */
  const costing = (spent: UsageRecord[], refuses: boolean) => ({
    isEmpty: false,
    fieldKey: "field-key",
    previous: {},
    maskCacheKeyOf: (text: string) => text,
    mask: (text: string) =>
      Promise.resolve({ masked: { text, blocked: [], tokens: {} }, usage: spent }),
    refusalError: () =>
      Promise.resolve(
        refuses
          ? new PiiError.Refused({ piiKind: "card", refusal: "no cards", usage: spent })
          : undefined,
      ),
  });

  it("a result that is taken carries the cost of searching it", async () => {
    const spent = [record(0.25, "detector")];

    const closed = await closedResult(
      costing(spent, false) as never,
      undefined,
      { kind: "ok", value: "fine" },
      kilobytes(1),
    );

    expect(closed.usage).toEqual(spent);
    expect(closed.refusal).toBeUndefined();
  });

  it("a result refused by a block rule carries the same cost", async () => {
    const spent = [record(0.25, "detector")];

    const closed = await closedResult(
      costing(spent, true) as never,
      undefined,
      { kind: "ok", value: "4242" },
      kilobytes(1),
    );

    expect(closed.usage).toEqual(spent);
    expect(closed.refusal).toMatchObject({ name: "PiiError.Refused" });
  });
});
