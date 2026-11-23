/**
 * #1366: the files of a move's tool results are counted over the whole conversation, never per call: the
 * files and the bytes of the calls before add to the next one's, and over `maxFiles` or `maxTotalFileSize`
 * the step fails with `ModelFileLimitError` before any model call.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { ModelFileLimitError } from "../../../src/files/file-errors.js";
import { ModelFileLimit } from "../../../src/files/model-files.js";

const { filePiecesOf } = vi.hoisted(() => ({
  filePiecesOf: vi.fn(() => Promise.resolve({ pieces: [], tokens: {}, maskedTexts: [] })),
}));
vi.mock("../../../src/files/visit-files.js", async (original) => ({
  ...(await original<typeof import("../../../src/files/visit-files.js")>()),
  filePiecesOf,
}));

const { makeCollectNode } = await import("../../../src/graph/agent-loop/collect-node.js");

const filesOf = (count: number, bytes: number) => ({
  sources: [],
  digests: [],
  count,
  bytes,
});

/** A move of one call per entry of `calls`, each result holding that many files and bytes; the loop's files so far in `tally`. */
function collected(
  calls: readonly { count: number; bytes: number }[],
  settings: { maxFiles: number; maxTotalFileSize: number },
  tally = { count: 0, bytes: 0 },
): Promise<unknown> {
  const node = makeCollectNode({
    agent: { name: "alpha" },
    fileRuntime: { settings },
  } as never);
  const state = {
    move: new AIMessage({
      content: "",
      tool_calls: calls.map((_, at) => ({
        id: `c${String(at)}`,
        name: "t",
        args: {},
        type: "tool_call" as const,
      })),
    }),
    results: Object.fromEntries(
      calls.map((call, at) => [
        `c${String(at)}`,
        {
          callId: `c${String(at)}`,
          tool: "t",
          content: "ok",
          files: filesOf(call.count, call.bytes),
        },
      ]),
    ),
    decisions: {},
    callRecords: {},
    usage: [],
    from: { usage: 0 },
    flowPath: ["flow", "alpha"],
    runId: "r",
    fileTally: tally,
    fileTranscripts: {},
    piiTokens: {},
  };
  return node(state as never, {} as never).then(
    (update) => update,
    (error: unknown) => error,
  );
}

const WIDE = { maxFiles: 1000, maxTotalFileSize: 1_000_000 };

describe("#1366: the files of the conversation are counted across calls", () => {
  it("two calls of 2 files under a maxFiles of 3: the second takes the conversation to 4, over", async () => {
    const outcome = await collected(
      [
        { count: 2, bytes: 1 },
        { count: 2, bytes: 1 },
      ],
      {
        ...WIDE,
        maxFiles: 3,
      },
    );

    expect(outcome).toBeInstanceOf(ModelFileLimitError);
    expect(outcome).toMatchObject({ limit: ModelFileLimit.MaxFiles, actual: 4, allowed: 3 });
  });

  it("the files up to maxFiles are let through: 2 and 1 of 3, and the tally is their sum", async () => {
    const outcome = await collected(
      [
        { count: 2, bytes: 5 },
        { count: 1, bytes: 7 },
      ],
      {
        ...WIDE,
        maxFiles: 3,
      },
    );

    expect(outcome).toMatchObject({ fileTally: { count: 3, bytes: 12 } });
  });

  it("the files of earlier moves count too: 2 held and a call of 2 under a maxFiles of 3", async () => {
    const outcome = await collected(
      [{ count: 2, bytes: 1 }],
      { ...WIDE, maxFiles: 3 },
      { count: 2, bytes: 0 },
    );

    expect(outcome).toMatchObject({ limit: ModelFileLimit.MaxFiles, actual: 4, allowed: 3 });
  });

  it("the bytes are summed across calls: two of 600 under a maxTotalFileSize of 1000", async () => {
    const outcome = await collected(
      [
        { count: 1, bytes: 600 },
        { count: 1, bytes: 600 },
      ],
      {
        ...WIDE,
        maxTotalFileSize: 1000,
      },
    );

    expect(outcome).toBeInstanceOf(ModelFileLimitError);
    expect(outcome).toMatchObject({
      limit: ModelFileLimit.MaxTotalFileSize,
      actual: 1200,
      allowed: 1000,
    });
  });
});
