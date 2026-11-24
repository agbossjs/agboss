/**
 * #382, #1303 — a code compaction (a `@Memory` class with a `compact(input)` method): its `compact()` is
 * called with the turns due (counted as a model's are: older than the window, every
 * `turnsBetweenCompactions`, before the next turn reads its thread) and the summaries readers see,
 * masked by the PII policies; what it gives is stored, revealed, and read back by the readers and the
 * next `compact()`. `[memory.conflicting-compaction]`, `agboss describe`'s line and `configHash`.
 */
import { describe, expect, it } from "vitest";
import {
  CompactionStrategy,
  Memory,
  StepError,
  Ttl,
  type CompactionTurn,
} from "../../src/index.js";
import { applicationOf } from "../../src/application/assemble.js";
import { memoryViolations } from "../../src/memory/checks.js";
import { memoryLines } from "../../src/describe/defaults.js";
import { configSnapshot } from "../../src/run/versions.js";
import { versionOf } from "../../src/turns/index.js";
import { replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { ExecutionOutput } from "../../src/app/types.js";
import type { Class } from "../../src/components/injection.js";
import { execute } from "../helpers/flow.js";
import {
  GraphAgent,
  GraphDeskApplication,
  GraphMemory,
  GraphStart,
  KnowledgeGraphService,
  OtherGraphDeskApplication,
  graphDeskOn,
} from "./custom-compaction.fixture.js";

/** What a model read, as one string. */
const textOf = (request: ModelRequest): string =>
  request.kind === "chat"
    ? request.messages
        .map((line) => (typeof line.text === "string" ? line.text : JSON.stringify(line.text)))
        .join("\n\n")
    : JSON.stringify(request.input);

/** `count` turns on one thread — t1, t2, … unless given; every result, in order. */
async function conversation(
  app: TestApp,
  count: number,
  textOfTurn: (turn: number) => string = (turn) => `t${String(turn)}`,
): Promise<ExecutionOutput[]> {
  const first = await execute(app, GraphStart, { text: textOfTurn(1) });
  const results = [first];
  for (let turn = 2; turn <= count; turn++) {
    const options = { threadId: first.threadId };
    results.push(await execute(app, GraphStart, { text: textOfTurn(turn) }, options));
  }
  return results;
}

/** A turn as `compact()` reads it: the start's input, the finish's output. */
const turn = (text: string, answer = "ok"): CompactionTurn => ({
  start: "graph-workflow-start",
  input: { text },
  finish: "graph-workflow-finish",
  output: { text: answer },
});

describe("#382: compact() is called with the turns due and the previous summaries", () => {
  const test = testWith(GraphDeskApplication);

  test("every 2 turns older than the window, before the next turn, in its execution's frame", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockLlm(GraphAgent).thenReturnAlways(replyWith("ok"));
    const graph = mockOf(KnowledgeGraphService);
    graph.saveFactsAndSummarize
      .mockResolvedValueOnce(["t1 and t2"])
      .mockResolvedValueOnce(["t1 and t2", "t3 and t4"]);

    const results = await conversation(app, 6);

    const threadId = results[0]?.threadId;
    expect(graph.saveFactsAndSummarize.mock.calls).toEqual([
      [threadId, [turn("t1"), turn("t2")], []],
      [threadId, [turn("t3"), turn("t4")], ["t1 and t2"]],
    ]);
    // a turn before which nothing was due has none
    expect(results.map((result) => result.compacted)).toEqual([
      undefined,
      undefined,
      undefined,
      [
        {
          memory: "graph-memory",
          fromTurn: 1,
          toTurn: 2,
          summaries: 1,
        },
      ],
      undefined,
      [
        {
          memory: "graph-memory",
          fromTurn: 3,
          toTurn: 4,
          summaries: 2,
        },
      ],
    ]);
  });

  test("its summaries are stored and read: a reader sees the list compact() gave last", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(GraphAgent).thenReturnAlways(replyWith("ok"));

    await conversation(app, 6);

    const last = textOf(mockLlm(GraphAgent).lastRequest);
    expect(last).toContain('[1] fact: {"text":"t1"}');
    expect(last).toContain('[4] fact: {"text":"t4"}');
    expect(last).not.toContain('start graph-workflow-start: {"text":"t2"}');
  });
});

describe("#382: a custom compaction is tested through its services", () => {
  const test = testWith(GraphDeskApplication);

  test("mockLlm of it is a setup error: it calls no model", async ({ mockLlm }) => {
    expect(() => mockLlm(GraphMemory)).toThrow(
      "mockLlm(GraphMemory): a custom compaction calls no model — mockOf() it, or the services its compact() uses",
    );
  });
});

describe("#382: compact() reads its input masked; what it gives is stored revealed", () => {
  const test = testWith(GraphDeskApplication);

  test("a token for compact(), the address for the store and a reader that excludes the policy", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockLlm(GraphAgent).thenReturnAlways(replyWith("written"));
    const graph = mockOf(KnowledgeGraphService);
    graph.saveFactsAndSummarize.mockImplementation((_threadId, turns: readonly CompactionTurn[]) =>
      Promise.resolve([`the user wrote ${JSON.stringify(turns[0]?.input)}`]),
    );

    await conversation(app, 4, (n) => (n === 1 ? "write to alice@example.com" : `t${String(n)}`));

    const [, turns] = graph.saveFactsAndSummarize.mock.calls[0] ?? [];
    const seen = JSON.stringify(turns);
    expect(seen).not.toContain("alice@example.com");
    expect(seen).toMatch(/<email:[0-9a-f]+>/u);
    expect(textOf(mockLlm(GraphAgent).lastRequest)).toContain(
      'the user wrote {"text":"write to alice@example.com"}',
    );
  });
});

class GraphUnavailableError extends Error {}

describe("#382: a compact() that fails fails the new execution — StepError.Memory", () => {
  const test = testWith(GraphDeskApplication);

  test("its error is the cause; nothing of the new turn runs", async ({ app, mockLlm, mockOf }) => {
    mockLlm(GraphAgent).thenReturn(replyWith("ok"), replyWith("ok"), replyWith("ok"));
    mockOf(KnowledgeGraphService).saveFactsAndSummarize.mockRejectedValue(
      new GraphUnavailableError("graph unavailable"),
    );
    const [first] = await conversation(app, 3);

    await expect(
      execute(app, GraphStart, { text: "t4" }, { threadId: first?.threadId }),
    ).rejects.toFailWith(StepError.Memory, {
      memory: "graph-memory",
      cause: GraphUnavailableError,
    });
  });

  test("no summaries is not a summary", async ({ app, mockLlm, mockOf }) => {
    mockLlm(GraphAgent).thenReturn(replyWith("ok"), replyWith("ok"), replyWith("ok"));
    mockOf(KnowledgeGraphService).saveFactsAndSummarize.mockResolvedValue([]);
    const [first] = await conversation(app, 3);

    await expect(
      execute(app, GraphStart, { text: "t4" }, { threadId: first?.threadId }),
    ).rejects.toFailWith(StepError.Memory, { memory: "graph-memory" });
  });
});

describe("#1303: [memory.conflicting-compaction] — a compaction in the decorator and a compact() method", () => {
  it("the decorator's types: no compact method beside a declarative compaction", () => {
    // @ts-expect-error -- a declarative compaction and compact(input) are two ways to compact
    @Memory({
      name: "both-ways-memory",
      description: "Both ways",
      ttl: Ttl.Forever,
      compaction: { strategy: CompactionStrategy.SingleSummary },
    })
    class BothWaysMemory {
      compact(): readonly string[] {
        return ["a summary"];
      }
    }

    expect(memoryViolations([BothWaysMemory])).toEqual([
      expect.objectContaining({ code: "memory.conflicting-compaction" }),
    ]);
  });

  it("a memory with neither is the window only: no rule is broken", () => {
    @Memory({ name: "plain-memory", description: "The window only", ttl: Ttl.Forever })
    class PlainMemory {}

    expect(memoryViolations([PlainMemory])).toEqual([]);
  });

  it("agboss check: a count below 1 on a code compaction", () => {
    @Memory({
      name: "busy-code-memory",
      description: "A code compaction with a bad count",
      ttl: Ttl.Forever,
      turnsBetweenCompactions: 0,
    })
    class BusyCodeMemory {
      compact(): readonly string[] {
        return ["a summary"];
      }
    }

    expect(memoryViolations([BusyCodeMemory]).map((found) => found.message)).toEqual([
      "busy-code-memory: turnsBetweenCompactions 0 — a whole number from 1",
    ]);
  });
});

/** The assembled graph desk of an application. */
async function graphDeskOf(application: Class) {
  const [workflow] = (await applicationOf(application)).workflows;
  if (workflow === undefined) throw new Error("the application has a workflow");
  return workflow;
}

describe("#382: agboss describe and configHash", () => {
  it("describe: strategy: custom (GraphMemory.compact())", async () => {
    const lines = memoryLines(await graphDeskOf(GraphDeskApplication));

    expect(lines).toEqual([
      "memory",
      "  graph-memory — strategy: custom (GraphMemory.compact()) every 2 turns · older than 1 turns",
    ]);
  });

  it("configHash: another class under the same name is another hash; the same class is the same", async () => {
    const hashOf = async (application: Class): Promise<string> =>
      versionOf(configSnapshot(await graphDeskOf(application)));
    const same = graphDeskOn(GraphMemory, "same-graph-desk-application");

    const base = await hashOf(GraphDeskApplication);

    expect(await hashOf(same)).toBe(base);
    expect(await hashOf(OtherGraphDeskApplication)).not.toBe(base);
  });
});
