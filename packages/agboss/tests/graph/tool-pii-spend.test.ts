/**
 * #1366: the spend of the tool task's PII reading — what a detection cost is on the closed result when a block
 * rule refuses it, whether the refusal came from a model the call made or from the result's own check.
 */
import { describe, expect, it } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { closedResult } from "../../src/graph/agent-loop/tool-pii.js";
import { PiiRefusedError } from "../../src/pii/errors.js";
import { kilobytes } from "../../src/units/index.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

describe("#1366: a refused tool result keeps what the detection cost", () => {
  it("the refusal of a model the call made carries that model's usage", async () => {
    const spent = [record(0.125, "detector")];
    const cause = new PiiRefusedError({ kind: "card-number", refusal: "no cards", usage: spent });

    const closed = await closedResult(
      undefined,
      undefined,
      { kind: "error", message: cause.message, cause },
      kilobytes(1),
    );

    expect(closed).toMatchObject({ refusal: cause, usage: spent, isTruncated: false });
    expect(closed.content).toContain("no cards");
  });
});
