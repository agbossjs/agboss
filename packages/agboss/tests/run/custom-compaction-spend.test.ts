import { usd } from "../../src/units/index.js";
/**
 * #1366: what masking a custom compaction's input cost — every paid detection of its summaries and
 * turns is in the usage the compaction hands back, so the budget left for the next compaction and the
 * run's spend see it.
 */
import { describe, expect, it, vi } from "vitest";
import type { CompactionInput } from "../../src/memory/memory.decorator.js";
import { CUSTOM_COMPACTION } from "../../src/memory/memory.decorator.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import type { CompactionRun } from "../../src/run/compaction.js";
import { compactWithHandler } from "../../src/run/custom-compaction.js";
import type { Turn } from "../../src/turns/index.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const turn = (id: string): Turn =>
  ({
    id,
    task: `start begin: ${JSON.stringify({ text: id })}`,
    replyWith: `finish end: ${JSON.stringify({ text: "ok" })}`,
    status: "answered",
  }) as never;

/** Policies whose every search costs a record named after the text it read. */
const costing = (searches: string[]) => ({
  isEmpty: false,
  mask: (text: string) => {
    searches.push(text);
    return Promise.resolve({
      masked: { text, blocked: [], tokens: {} },
      usage: [record(0.125, `detect:${text}`)],
    });
  },
});

function run() {
  const recorded: UsageRecord[] = [];
  const base: CompactionRun = {
    tenantId: "t",
    threadId: "th",
    budgetLeftUsd: usd(10),
    callbacks: [],
    tokens: {},
    inFrame: (work) => work(),
    record: (records) => {
      recorded.push(...records);
      return Promise.resolve();
    },
  };
  return { base, recorded };
}

describe("#1366: the usage of a custom compaction's masking", () => {
  it("every text of the summaries and the turns is searched, and each search's usage is handed back", async () => {
    const searches: string[] = [];
    const given: CompactionInput[] = [];
    const deps = {
      pii: { workflowPolicies: costing(searches) },
      turns: {
        latestSummaries: () => Promise.resolve([{ text: JSON.stringify(["old summary"]) }]),
        addSummary: vi.fn(() => Promise.resolve()),
        turnNumber: () => Promise.resolve(1),
      },
      config: { name: "bundle" },
      container: {
        get: () => ({
          compact: (input: CompactionInput) => {
            given.push(input);
            return ["new summary"];
          },
        }),
      },
    };
    const { base, recorded } = run();
    const compaction = { name: "graph", strategy: CUSTOM_COMPACTION, type: Object };

    const outcome = await compactWithHandler(deps as never, compaction as never, base, [turn("a")]);

    expect(searches).toEqual(["old summary", "a", "ok"]);
    expect(outcome.usage.map((each) => each.caller)).toEqual([
      "detect:old summary",
      "detect:a",
      "detect:ok",
    ]);
    // the same usage reached the ledger as it was made
    expect(recorded).toEqual(outcome.usage);
    expect(given).toHaveLength(1);
  });
});
