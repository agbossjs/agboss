import { usd } from "../../src/units/index.js";
/**
 * #1366 (ledger-memory shard) — what both kinds of compaction share at run time, each rule on its own: a text read
 * through the PII policies with the spend of masking it recorded at once, and one summary stored with the records
 * it covers and its cost.
 */
import { describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { DetectionMode } from "../../src/pii/runtime-policy.js";
import { maskedTextOf, storedCompaction } from "../../src/run/compaction-parts.js";

const record = (costUsd: number): UsageRecord => ({
  ...ZERO_USAGE,
  caller: "pii",
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

describe("#1366: a text through the policies", () => {
  it("without policies, or with empty ones, is the text as it is, its tokens kept, nothing spent", async () => {
    const recorded = vi.fn();
    const tokens = { a: "1" } as never;

    const none = await maskedTextOf({} as never, "t", { record: recorded }, tokens);
    const empty = await maskedTextOf(
      { pii: { workflowPolicies: { isEmpty: true } } } as never,
      "t",
      { record: recorded },
      tokens,
    );

    for (const out of [none, empty]) {
      expect(out).toEqual({ text: "t", tokens, usage: [] });
      expect(out.tokens).toBe(tokens);
    }
    expect(recorded).not.toHaveBeenCalled();
  });

  it("masks with the model, records what that cost at once, and adds the new tokens to the known", async () => {
    const mask = vi.fn(() =>
      Promise.resolve({ masked: { text: "<m>", tokens: { b: "2" } }, usage: [record(0.25)] }),
    );
    const recorded = vi.fn(() => Promise.resolve());
    const deps = { pii: { workflowPolicies: { isEmpty: false, mask } } } as never;

    const out = await maskedTextOf(deps, "secret", { record: recorded }, { a: "1" });

    expect(mask).toHaveBeenCalledWith("secret", { a: "1" }, DetectionMode.WithModel);
    expect(recorded).toHaveBeenCalledWith([record(0.25)]);
    expect(out).toEqual({ text: "<m>", tokens: { a: "1", b: "2" }, usage: [record(0.25)] });
  });
});

describe("#1366: one compaction stored", () => {
  const turn = (id: string) => ({ id }) as never;
  const depsOf = () => {
    const addSummary = vi.fn(() => Promise.resolve());
    const turnNumber = vi.fn((_t: string, _th: string, id: string) =>
      Promise.resolve(id === "a" ? 1 : 7),
    );
    return {
      deps: { config: { name: "bundle" }, turns: { addSummary, turnNumber } } as never,
      addSummary,
      turnNumber,
    };
  };
  const run = { tenantId: "tenant-1", threadId: "thread-1" };
  const write = {
    compaction: "notes",
    due: [turn("a"), turn("b"), turn("c")],
    text: "summary",
    costUsd: usd(0.5),
    summaries: 2,
    summaryQueueLength: 4,
  };

  it("covers the thread from its first due record to the last, with the text and its cost", async () => {
    const { deps, addSummary, turnNumber } = depsOf();

    const out = await storedCompaction(deps, run, write);

    expect(addSummary).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      threadId: "thread-1",
      bundle: "bundle",
      compaction: "notes",
      fromTurnId: "a",
      toTurnId: "c",
      turns: 3,
      text: "summary",
      costUsd: usd(0.5),
    });
    expect(turnNumber).toHaveBeenCalledWith("tenant-1", "thread-1", "a");
    expect(turnNumber).toHaveBeenCalledWith("tenant-1", "thread-1", "c");
    expect(out).toEqual({
      compaction: "notes",
      fromTurn: 1,
      toTurn: 7,
      summaries: 2,
      summaryQueueLength: 4,
    });
  });

  it("a summary it rewrites covers the thread from its own start and its turns count too", async () => {
    const { deps, addSummary } = depsOf();

    await storedCompaction(deps, run, {
      ...write,
      current: { fromTurnId: "z", turns: 5 } as never,
    });

    expect(addSummary).toHaveBeenCalledWith(
      expect.objectContaining({ fromTurnId: "z", toTurnId: "c", turns: 8 }),
    );
  });

  it("nothing due stores nothing", async () => {
    const { deps, addSummary } = depsOf();

    expect(await storedCompaction(deps, run, { ...write, due: [] })).toBeUndefined();
    expect(addSummary).not.toHaveBeenCalled();
  });
});
