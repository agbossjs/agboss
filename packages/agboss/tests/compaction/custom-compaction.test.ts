/**
 * #382 — a custom compaction (`CompactionStrategy.Custom` + `CompactionHandler`): its `compact()` is
 * called with the turns due (counted as a model's are: older than the window, every
 * `turnsBetweenCompactions`, before the next turn reads its thread) and the summaries readers see,
 * masked by the PII policies; what it gives is stored, revealed, and read back by the readers and the
 * next `compact()`. `[compaction.missing-handler]`, `agboss describe`'s line and `configHash`.
 */
import { describe, expect, it } from "vitest";
import {
  Compaction,
  CompactionError,
  CompactionStrategy,
  type CompactionTurn,
} from "../../src/index.js";
import { applicationOf } from "../../src/application/assemble.js";
import { compactionViolations } from "../../src/compaction/checks.js";
import { memoryLines } from "../../src/describe/defaults.js";
import { configSnapshot } from "../../src/run/versions.js";
import { versionOf } from "../../src/terns/index.js";
import { replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { ExecutionOutput } from "../../src/app/types.js";
import type { Class } from "../../src/components/injection.js";
import { execute } from "../helpers/flow.js";
import {
  GraphAgent,
  GraphDeskApplication,
  GraphMemoryCompaction,
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
  startName: "graph-workflow-start",
  input: { text },
  finishName: "graph-workflow-finish",
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
          compaction: "graph-memory-compaction",
          fromTurn: 1,
          toTurn: 2,
          summaries: 1,
          summaryQueueLength: 1,
        },
      ],
      undefined,
      [
        {
          compaction: "graph-memory-compaction",
          fromTurn: 3,
          toTurn: 4,
          summaries: 2,
          summaryQueueLength: 2,
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
    expect(() => mockLlm(GraphMemoryCompaction)).toThrow(
      "mockLlm(GraphMemoryCompaction): a custom compaction calls no model — mockOf() it, or the services its compact() uses",
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

describe("#382: a compact() that fails fails the new execution — CompactionError", () => {
  const test = testWith(GraphDeskApplication);

  test("its error is the cause; nothing of the new turn runs", async ({ app, mockLlm, mockOf }) => {
    mockLlm(GraphAgent).thenReturn(replyWith("ok"), replyWith("ok"), replyWith("ok"));
    mockOf(KnowledgeGraphService).saveFactsAndSummarize.mockRejectedValue(
      new GraphUnavailableError("graph unavailable"),
    );
    const [first] = await conversation(app, 3);

    await expect(
      execute(app, GraphStart, { text: "t4" }, { threadId: first?.threadId }),
    ).rejects.toFailWith(CompactionError, {
      compaction: "graph-memory-compaction",
      cause: GraphUnavailableError,
    });
  });

  test("no summaries is not a summary", async ({ app, mockLlm, mockOf }) => {
    mockLlm(GraphAgent).thenReturn(replyWith("ok"), replyWith("ok"), replyWith("ok"));
    mockOf(KnowledgeGraphService).saveFactsAndSummarize.mockResolvedValue([]);
    const [first] = await conversation(app, 3);

    await expect(
      execute(app, GraphStart, { text: "t4" }, { threadId: first?.threadId }),
    ).rejects.toFailWith(CompactionError, { compaction: "graph-memory-compaction" });
  });
});

describe("#382: [compaction.missing-handler] and no model's settings on a custom compaction", () => {
  it("the decorator's types: a compact method, no model, prompt or summary limits", () => {
    // @ts-expect-error -- a custom compaction implements CompactionHandler: compact(input)
    @Compaction({
      name: "handlerless-compaction",
      description: "No compact()",
      strategy: CompactionStrategy.Custom,
      turnsBetweenCompactions: 1,
    })
    class HandlerlessCompaction {}

    // @ts-expect-error -- CompactionStrategy.Custom takes no model
    Compaction({
      name: "modelled-custom-compaction",
      description: "A model on a custom compaction",
      strategy: CompactionStrategy.Custom,
      turnsBetweenCompactions: 1,
      model: "test/compactor",
    });

    expect(compactionViolations([HandlerlessCompaction])).toEqual([
      expect.objectContaining({
        code: "compaction.missing-handler",
        message:
          "HandlerlessCompaction (handlerless-compaction) is CompactionStrategy.Custom but has no compact(input) method — implements CompactionHandler",
      }),
    ]);
  });

  it("agboss check: a model's settings and a count below 1, all at once", () => {
    const options: unknown = {
      name: "busy-custom-compaction",
      description: "Settings a custom compaction does not take",
      strategy: CompactionStrategy.Custom,
      turnsBetweenCompactions: 0,
      model: "test/compactor",
      summaryMaxTokens: 100,
      summaryQueueLength: 2,
    };
    class BusyCustomCompaction {
      compact(): readonly string[] {
        return ["a summary"];
      }
    }
    Reflect.apply(Compaction, undefined, [options])(BusyCustomCompaction);

    expect(compactionViolations([BusyCustomCompaction]).map((found) => found.message)).toEqual([
      "busy-custom-compaction: turnsBetweenCompactions 0 — a whole number from 1",
      "busy-custom-compaction: model test/compactor — CompactionStrategy.Custom takes none",
      "busy-custom-compaction: summaryMaxTokens 100 — CompactionStrategy.Custom takes none",
      "busy-custom-compaction: summaryQueueLength 2 — CompactionStrategy.Custom takes none",
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
  it("describe: strategy: custom (GraphMemoryCompaction.compact())", async () => {
    const lines = memoryLines(await graphDeskOf(GraphDeskApplication));

    expect(lines).toEqual([
      "memory",
      "  graph-memory-compaction — strategy: custom (GraphMemoryCompaction.compact()) every 2 turns · older than 1 turns",
    ]);
  });

  it("configHash: another class under the same name is another hash; the same class is the same", async () => {
    const hashOf = async (application: Class): Promise<string> =>
      versionOf(configSnapshot(await graphDeskOf(application)));
    const same = graphDeskOn(GraphMemoryCompaction, "same-graph-desk-application");

    const base = await hashOf(GraphDeskApplication);

    expect(await hashOf(same)).toBe(base);
    expect(await hashOf(OtherGraphDeskApplication)).not.toBe(base);
  });
});
