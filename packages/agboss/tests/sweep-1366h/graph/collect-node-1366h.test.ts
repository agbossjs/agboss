/**
 * #1366: the collect node's outcome for a move's results: what a call with no result and no decision tells the
 * model, the records of its trajectory, the files of the conversation (the limit is met only past the
 * maximum, never when a call has no runtime, the files are numbered with their digests, the tokens of one
 * call are known to the masking of the next) and the update it returns only when files were added.
 */
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { rejectionMessage } from "../../../src/prompts/agents.js";

const { filePiecesOf } = vi.hoisted(() => ({
  filePiecesOf: vi.fn(),
}));
vi.mock("../../../src/files/visit-files.js", async (original) => ({
  ...(await original<typeof import("../../../src/files/visit-files.js")>()),
  filePiecesOf,
}));

const { makeCollectNode } = await import("../../../src/graph/agent-loop/collect-node.js");

const SETTINGS = { maxFiles: 10, maxTotalFileSize: 1000 };

interface Call {
  readonly sources?: readonly string[];
  readonly digests?: readonly string[];
  readonly count?: number;
  readonly bytes?: number;
}

const policySet = {
  isEmpty: false,
  fingerprint: "fp",
  redaction: {},
  redactionDigestOf: () => "d",
  maskCacheKeyOf: (text: string) => `key:${text}`,
  refusalForKind: () => undefined,
  mask: () => Promise.reject(new Error("not used")),
};
const withPolicies = {
  pii: { withValues: () => ({ withFieldKey: () => policySet }) },
};

interface Options {
  readonly calls?: readonly (Call | undefined)[];
  readonly runtime?: boolean;
  readonly masked?: boolean;
  readonly records?: Record<string, unknown>;
  readonly piiTokens?: Record<string, string>;
}

async function collected(options: Options = {}): Promise<Record<string, unknown>> {
  const { calls = [], runtime = true, masked = false, records = {}, piiTokens = {} } = options;
  const node = makeCollectNode({
    agent: { name: "alpha" },
    ...(runtime ? { fileRuntime: { settings: SETTINGS } } : {}),
    ...(masked ? withPolicies : {}),
  } as never);
  const ids = calls.map((_, at) => `c${String(at)}`);
  const state = {
    move: new AIMessage({
      content: "",
      tool_calls: ids.map((id) => ({ id, name: "t", args: {}, type: "tool_call" as const })),
    }),
    results: Object.fromEntries(
      ids.flatMap((id, at) => {
        const call = calls[at];
        if (call === undefined) return [];
        const files = {
          sources: call.sources ?? [],
          digests: call.digests ?? [],
          count: call.count ?? 0,
          bytes: call.bytes ?? 0,
        };
        return [[id, { callId: id, tool: "t", content: `out-${id}`, files }]];
      }),
    ),
    decisions: {},
    callRecords: records,
    usage: [],
    from: { usage: 0 },
    flowPath: ["flow", "alpha"],
    runId: "r",
    fileTally: { count: 0, bytes: 0 },
    fileTranscripts: {},
    piiTokens,
    piiValues: {},
    piiKey: "k",
  };
  return await node(state as never, {} as never);
}

const noPieces = () => Promise.resolve({ pieces: [], tokens: {}, maskedTexts: [] });

describe("#1366: a call without a result or a decision", () => {
  it("the model reads that the loop rejected it; no approval and no trajectory record is made", async () => {
    filePiecesOf.mockReset();

    const update = await collected({ calls: [undefined] });

    const messages = update.messages as ToolMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe(rejectionMessage("the loop", undefined));
    expect(update.approvals).toEqual([]);
    expect(update.trajectory).toEqual([]);
    expect(update).not.toHaveProperty("fileTally");
  });

  it("a call with a record has it in the trajectory, in the move's order", async () => {
    filePiecesOf.mockReset().mockImplementation(noPieces);
    const records = { c0: { id: "r0" }, c1: { id: "r1" } };

    const update = await collected({ calls: [{}, undefined, {}], records });

    expect(update.trajectory).toEqual([{ id: "r0" }, { id: "r1" }]);
  });
});

describe("#1366: the files of a move's results", () => {
  it("a result with files but an agent with no file runtime adds nothing and reads nothing", async () => {
    filePiecesOf.mockReset();

    const update = await collected({ calls: [{ count: 1, bytes: 1 }], runtime: false });

    expect(filePiecesOf).not.toHaveBeenCalled();
    expect(update).not.toHaveProperty("fileTally");
    expect(update.messages).toHaveLength(1);
  });

  it("bytes exactly at the maximum are let through", async () => {
    filePiecesOf.mockReset().mockImplementation(noPieces);

    const update = await collected({ calls: [{ count: 1, bytes: 1000 }] });

    expect(update).toMatchObject({ fileTally: { count: 1, bytes: 1000 } });
  });

  it("a file is read as the n-th of the conversation, pinned to its digest, its text a piece of the message", async () => {
    filePiecesOf.mockReset().mockImplementation(() =>
      Promise.resolve({
        pieces: [{ kind: "text", text: "page one" }],
        tokens: {},
        maskedTexts: [],
      }),
    );

    const update = await collected({
      calls: [{ sources: ["s1", "s2"], digests: ["d1"], count: 2, bytes: 3 }],
    });

    const messages = update.messages as { content: unknown }[];
    expect(messages[1]?.content).toEqual([{ type: "text", text: "page one" }]);
    expect(filePiecesOf).toHaveBeenCalledWith(
      expect.objectContaining({ first: 1, pins: ["d1"], files: ["s1", "s2"] }),
    );
    expect(update.seen).toEqual([{ source: "s1", digest: "d1" }]);
  });

  it("without policies the masked texts are not kept and the tokens are the calls' tokens together", async () => {
    filePiecesOf
      .mockReset()
      .mockImplementationOnce(() =>
        Promise.resolve({ pieces: [], tokens: { "<a:111111>": "A" }, maskedTexts: ["t1"] }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ pieces: [], tokens: { "<b:222222>": "B" }, maskedTexts: [] }),
      );

    const update = await collected({ calls: [{ count: 1 }, { count: 1 }] });

    expect(update.piiMasked).toEqual({});
    expect(update.piiTokens).toEqual({ "<a:111111>": "A", "<b:222222>": "B" });
    expect(update.seen).toEqual([]);
  });

  it("with policies each call's masking knows the tokens before it, and the masked texts are kept by their key", async () => {
    filePiecesOf
      .mockReset()
      .mockImplementationOnce(() =>
        Promise.resolve({ pieces: [], tokens: { "<a:111111>": "A" }, maskedTexts: ["t1", "t2"] }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ pieces: [], tokens: {}, maskedTexts: ["t3"] }),
      );

    const update = await collected({
      calls: [{ count: 1 }, { count: 1 }],
      masked: true,
      piiTokens: { "<z:999999>": "Z" },
    });

    const knownAt = (call: number): unknown =>
      (filePiecesOf.mock.calls[call]?.[0] as { mask: { known: unknown } }).mask.known;
    expect(knownAt(0)).toEqual({ "<z:999999>": "Z" });
    expect(knownAt(1)).toEqual({ "<z:999999>": "Z", "<a:111111>": "A" });
    expect(update.piiMasked).toEqual({ "key:t1": "t1", "key:t2": "t2", "key:t3": "t3" });
  });
});
