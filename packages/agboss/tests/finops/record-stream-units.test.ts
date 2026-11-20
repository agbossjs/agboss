/**
 * #1356 — the multiset by which a stream's usage counts once: two equal records are the same spend,
 * whatever order they come in, and a record differing in any one field is another spend.
 */
import { describe, expect, it } from "vitest";
import {
  drainRecordingUsage,
  EmptyRunError,
  unrecordedOf,
  type HasUsage,
} from "../../src/finops/record-stream.js";
import { CostSource, type UsageRecord } from "../../src/finops/usage.js";
import { usageRecord } from "../helpers.js";

const base = usageRecord("agent", 0.5);

/** `base` with one field changed: a spend of its own. */
const variants: readonly (readonly [string, UsageRecord])[] = [
  ["caller", { ...base, caller: "other" }],
  ["model", { ...base, model: "other/m" }],
  ["costUsd", { ...base, costUsd: 0.6 }],
  ["costSource", { ...base, costSource: CostSource.Api }],
  ["inputTokens", { ...base, inputTokens: 1 }],
  ["outputTokens", { ...base, outputTokens: 1 }],
  ["cacheReadTokens", { ...base, cacheReadTokens: 1 }],
  ["cacheWriteTokens", { ...base, cacheWriteTokens: 1 }],
];

describe("#1356: the records not yet recorded", () => {
  it("none of the records is unrecorded when all are", () => {
    expect(unrecordedOf([base], [base])).toEqual([]);
    expect(unrecordedOf([], [])).toEqual([]);
  });

  it.each(variants)(
    "a record differing only in its %s is not the recorded one",
    (_field, other) => {
      expect(unrecordedOf([other], [base])).toEqual([other]);
      expect(unrecordedOf([base], [other])).toEqual([base]);
    },
  );

  it("two equal records are the same spend, however their fields were listed", () => {
    const reordered: UsageRecord = {
      costSource: base.costSource,
      costUsd: base.costUsd,
      cacheWriteTokens: base.cacheWriteTokens,
      cacheReadTokens: base.cacheReadTokens,
      outputTokens: base.outputTokens,
      inputTokens: base.inputTokens,
      model: base.model,
      caller: base.caller,
    };

    expect(unrecordedOf([reordered], [base])).toEqual([]);
  });

  it("counts as a multiset: n recorded equal records are the first n of the equal ones", () => {
    const [first, second, third] = [base, { ...base }, { ...base }];

    expect(unrecordedOf([first, second, third], [base])).toEqual([second, third]);
    expect(unrecordedOf([first, second, third], [base, base])).toEqual([third]);
    expect(unrecordedOf([first, second, third], [base, base, base])).toEqual([]);
    expect(unrecordedOf([first, second, third], [base, base, base, base])).toEqual([]);
  });

  it("keeps the records in their order and takes the equal ones from the start, wherever they are", () => {
    const other = usageRecord("other", 1);

    expect(unrecordedOf([other, base, other, base], [base])).toEqual([other, other, base]);
    expect(unrecordedOf([base, other], [other])).toEqual([base]);
  });
});

async function* states(...items: HasUsage[]): AsyncGenerator<HasUsage> {
  for (const item of items) yield await Promise.resolve(item);
}

describe("#1356: a drained stream's usage", () => {
  it("hands over only what neither the caller nor an earlier state had recorded", async () => {
    const [a, b, c] = [usageRecord("a", 1), usageRecord("b", 2), usageRecord("c", 3)];
    const batches: (readonly UsageRecord[])[] = [];

    const last = await drainRecordingUsage(
      states({ usage: [a] }, { usage: [a, b] }, { usage: [a, b, b, c] }),
      (records) => {
        batches.push(records);
        return Promise.resolve();
      },
      [a],
    );

    expect(batches).toEqual([[], [b], [b, c]]);
    expect(last.usage).toEqual([a, b, b, c]);
  });

  it("hands over everything when nothing was recorded before", async () => {
    const batches: (readonly UsageRecord[])[] = [];

    await drainRecordingUsage(states({ usage: [base, base] }), (records) => {
      batches.push(records);
      return Promise.resolve();
    });

    expect(batches).toEqual([[base, base]]);
  });

  it("does not change the records the caller passed as already recorded", async () => {
    const already = [base];

    await drainRecordingUsage(
      states({ usage: [base, usageRecord("b", 1)] }),
      () => Promise.resolve(),
      already,
    );

    expect(already).toEqual([base]);
  });

  it("fails on a run that produced no state, with its message", async () => {
    const failure: unknown = await drainRecordingUsage(states(), () => Promise.resolve()).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(EmptyRunError);
    expect(failure).toHaveProperty("name", "EmptyRunError");
    expect(failure).toHaveProperty("message", "The run produced no state");
  });

  it("records what a failing run spent before it failed", async () => {
    const recorded: UsageRecord[] = [];
    async function* failing(): AsyncGenerator<HasUsage> {
      yield await Promise.resolve({ usage: [base] });
      throw new Error("model down");
    }

    await expect(
      drainRecordingUsage(failing(), (records) => {
        recorded.push(...records);
        return Promise.resolve();
      }),
    ).rejects.toThrow("model down");
    expect(recorded).toEqual([base]);
  });
});
