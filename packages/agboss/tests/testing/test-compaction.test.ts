/**
 * #395 PR 5 (S2 Q4): `testCompaction(Compaction, options?)` — one compaction on its own, from a
 * `CompactionInput`: a model strategy's request and summaries on a scripted model, a custom one's
 * `compact()` on its own container. Whether a fact survives is an eval case (#396), not this.
 */
import { describe, expect, it } from "vitest";
import { StepError } from "../../src/index.js";
import { override, replyWith, TestSetupError, testCompaction } from "../../src/testing/index.js";
import { SINGLE_SUMMARY_PROMPT } from "../../src/prompts/compaction.js";
import { usd } from "../../src/units/index.js";
import { WindowOnlyMemory, NoteMemory, QueueMemory } from "../memory/compaction.fixture.js";
import { GraphMemory, KnowledgeGraphService } from "../memory/custom-compaction.fixture.js";

const TURNS = {
  previousSummaries: ["Dana asked about order 7."],
  turnsToCompact: [
    {
      start: "desk-workflow-start",
      input: { text: "Never call me before 9." },
      finish: "desk-workflow-finish",
      output: { text: "Noted." },
    },
  ],
};

describe("a model strategy", () => {
  it("SummaryQueue: the turns in its request, the new summary at the end of the queue", async () => {
    const compact = testCompaction(QueueMemory, {
      model: replyWith("Dana: no calls before 9.", { cost: usd(0.001) }),
    });

    const { output, spend } = await compact(TURNS);

    expect(output.summaries).toEqual(["Dana asked about order 7.", "Dana: no calls before 9."]);
    expect(output.requests).toEqual([
      {
        instructions: "Summarise the turns under `Turns to compact`.",
        input:
          'Turns to compact:\nstart desk-workflow-start: {"text":"Never call me before 9."}\nfinish desk-workflow-finish: {"text":"Noted."}',
      },
    ]);
    expect(spend.trace).toMatchObject([{ caller: "memory:queue-memory" }]);
    expect(spend.totalUsd).toBeCloseTo(0.001);
  });

  it("SummaryQueue keeps the latest summaryQueueLength summaries", async () => {
    const compact = testCompaction(QueueMemory, { model: replyWith("third") });

    const { output } = await compact({ ...TURNS, previousSummaries: ["first", "second"] });

    expect(output.summaries).toEqual(["second", "third"]);
  });

  it("SingleSummary: its current summary and the built-in prompt; the summary replaced", async () => {
    const compact = testCompaction(NoteMemory, {
      model: replyWith("Dana: order 7, no calls before 9."),
    });

    const { output } = await compact(TURNS);

    expect(output.summaries).toEqual(["Dana: order 7, no calls before 9."]);
    expect(output.requests[0]?.instructions).toBe(SINGLE_SUMMARY_PROMPT);
    expect(output.requests[0]?.input).toMatch(
      /^Current summary:\nDana asked about order 7\.\n\nTurns to add:\nstart desk-workflow-start: /,
    );
  });

  it("SingleSummary without a summary yet reads (none yet)", async () => {
    const compact = testCompaction(NoteMemory, { model: replyWith("first note") });

    const { output } = await compact({ ...TURNS, previousSummaries: [] });

    expect(output.requests[0]?.input).toMatch(/^Current summary:\n\(none yet\)\n\n/);
  });

  it("a summary cut at summaryMaxTokens is asked once more, shorter: two requests", async () => {
    const compact = testCompaction(QueueMemory, {
      model: [replyWith("a long…", { truncated: true }), replyWith("short")],
    });

    const { output } = await compact(TURNS);

    expect(output.summaries.at(-1)).toBe("short");
    expect(output.requests).toHaveLength(2);
    expect(output.requests[1]?.input.startsWith(output.requests[0]?.input ?? "?")).toBe(true);
  });

  it("cut twice, or empty: StepError.Memory", async () => {
    const cut = replyWith("cut", { truncated: true });
    const twice = testCompaction(QueueMemory, { model: [cut, cut] });
    const empty = testCompaction(QueueMemory, { model: replyWith("  ") });

    await expect(twice(TURNS)).rejects.toBeInstanceOf(StepError.Memory);
    await expect(empty(TURNS)).rejects.toThrow("the model wrote an empty summary");
  });
});

describe("a code compaction", () => {
  it("compact() on its own container, its services replaced, in a step's frame", async () => {
    const compact = testCompaction(GraphMemory);

    const { output, spend } = await compact(TURNS);

    expect(output).toEqual({
      summaries: ["Dana asked about order 7.", 'fact: {"text":"Never call me before 9."}'],
      requests: [],
    });
    expect(spend.totalUsd).toBe(0);
  });

  it("an override replaces a service; no summary is StepError.Memory", async () => {
    class EmptyGraph extends KnowledgeGraphService {
      override saveFactsAndSummarize(): Promise<readonly string[]> {
        return Promise.resolve([]);
      }
    }
    const compact = testCompaction(GraphMemory, {
      overrides: [override(KnowledgeGraphService, EmptyGraph)],
    });

    await expect(compact(TURNS)).rejects.toBeInstanceOf(StepError.Memory);
    await expect(compact(TURNS)).rejects.toThrow("compact() gave no summaries");
  });
});

describe("what the runner refuses", () => {
  it("a window-only memory writes nothing; a model for a custom one; not a compaction", () => {
    expect(() => testCompaction(WindowOnlyMemory)).toThrow(TestSetupError);
    expect(() => testCompaction(WindowOnlyMemory)).toThrow("writes no summaries");
    expect(() => testCompaction(GraphMemory, { model: replyWith("x") })).toThrow(
      "its compact() calls no model; leave out model",
    );
    class Plain {
      readonly isPlain = true;
    }
    expect(() => testCompaction(Plain)).toThrow("testCompaction(Plain): not a @Memory");
  });
});
