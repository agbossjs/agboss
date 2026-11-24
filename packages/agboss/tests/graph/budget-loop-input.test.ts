import { usd } from "../../src/units/index.js";
/**
 * #1366 (budget-loop shard) — the budget rules of an agent's input step, each on its own over fakes: the check
 * before a model call that reads a file (with the spend of the loop so far), the failures that rise as they are and
 * the one that fails the agent with its spend, and the input's spend — knowledge, guardrails, files — counted at once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { filePiecesOf } from "../../src/files/visit-files.js";
import { AgentFailedError } from "../../src/graph/errors.js";
import { makeInputNode } from "../../src/graph/agent-loop/input-node.js";
import { LimitExceededError } from "../../src/graph/limits.js";
import { gatherKnowledge } from "../../src/graph/nodes/knowledge.js";
import { PiiRefusedError } from "../../src/pii/errors.js";
import { loopPoliciesOf } from "../../src/graph/agent-loop/model-pii.js";
import { guardedFilesOf } from "../../src/files/guarded-files.js";
import { fileMaskOf } from "../../src/files/file-mask.js";
import { runGuardrails } from "../../src/guardrails/runtime.js";
import { maskedModelText } from "../../src/pii/model-boundary.js";

vi.mock("../../src/graph/nodes/knowledge.js", () => ({ gatherKnowledge: vi.fn() }));
vi.mock("../../src/graph/agent-loop/model-pii.js", () => ({ loopPoliciesOf: vi.fn() }));
vi.mock("../../src/files/guarded-files.js", () => ({ guardedFilesOf: vi.fn() }));
vi.mock("../../src/files/file-mask.js", () => ({ fileMaskOf: vi.fn() }));
vi.mock("../../src/guardrails/runtime.js", () => ({ runGuardrails: vi.fn() }));
vi.mock("../../src/pii/model-boundary.js", () => ({
  maskedModelText: vi.fn(),
  modelReadingMaskOf: vi.fn(() => undefined),
  withModelReading: vi.fn((_reading: unknown, work: () => unknown) => work()),
}));
vi.mock("../../src/files/visit-files.js", async (original) => ({
  ...(await original<typeof import("../../src/files/visit-files.js")>()),
  filePiecesOf: vi.fn(),
}));

const record = (costUsd: number, caller = "x"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

/** A list an update gives: its reducers take a plain list or an overwrite of one; these updates give plain ones. */
const listOf = <T>(value: readonly T[] | object | undefined): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

const NO_FILES = { count: 0, bytes: 0 };

const pieces = (changes: Record<string, unknown> = {}) => ({
  pieces: [],
  viewed: [],
  tokens: { f: "1" },
  maskedTexts: [],
  usage: [record(0.25, "file")],
  digests: ["d1", ""],
  transcripts: { k: "text" },
  tally: { count: 1, bytes: 10 },
  ...changes,
});

const stateOf = (changes: Record<string, unknown> = {}) =>
  ({
    runId: "run-1",
    usage: [record(1, "before"), record(0.5, "loop")],
    from: { usage: 1 },
    flowPath: ["a"],
    inputMessage: "hello",
    summaries: [],
    history: [],
    approvals: [],
    piiTokens: {},
    inputFiles: [],
    fileTally: NO_FILES,
    fileTranscripts: {},
    ...changes,
  }) as never;

function setup(options: { withRuntime?: boolean; guardrails?: unknown[] } = {}) {
  const tally = vi.fn((records: readonly UsageRecord[], _path?: readonly string[]) =>
    records.map((r) => ({ ...r, tallied: true })),
  );
  const check = vi.fn();
  const deps = {
    agent: { name: "alpha", knowledge: [], maxResultSize: undefined },
    budgets: { tally, check },
    fileRuntime: options.withRuntime === true ? { name: "runtime" } : undefined,
    guardrails: options.guardrails,
    observer: "observer",
  };
  vi.mocked(gatherKnowledge).mockResolvedValue({
    block: "",
    records: [record(0.125, "rag")],
  });
  vi.mocked(filePiecesOf).mockResolvedValue(pieces());
  return { node: makeInputNode(deps as never), tally, check };
}

const file = { fileId: "f1" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loopPoliciesOf).mockReturnValue(undefined);
});

describe("#1366: the input's spend is counted at once", () => {
  it("knowledge, guardrails and files are tallied together on the flow path; what the budgets give back is the loop's", async () => {
    const { node, tally } = setup({ withRuntime: true });

    const out = await node(stateOf({ inputFiles: [file] }), undefined);

    expect(tally).toHaveBeenCalledOnce();
    expect(tally.mock.calls[0]?.[0].map((u) => u.caller)).toEqual(["rag", "file"]);
    expect(tally.mock.calls[0]?.[1]).toEqual(["a"]);
    expect(listOf(out.usage).map((u) => u.costUsd)).toEqual([0.125, 0.25]);
    expect(listOf(out.usage).every((u) => (u as { tallied?: boolean }).tallied === true)).toBe(
      true,
    );
  });

  it("an input with no knowledge, guardrail or file spends nothing, and is still tallied once", async () => {
    const { node, tally } = setup();
    vi.mocked(gatherKnowledge).mockResolvedValue({ block: "", records: [] });

    const out = await node(stateOf(), undefined);

    expect(tally).toHaveBeenCalledWith([], ["a"]);
    expect(out.usage).toEqual([]);
  });

  it("keeps the files' tally, transcriptions and the digests of the files its model saw", async () => {
    const { node } = setup({ withRuntime: true });

    const out = await node(stateOf({ inputFiles: [file, { fileId: "f2" }] }), undefined);

    expect(out).toMatchObject({
      fileTally: { count: 1, bytes: 10 },
      fileTranscripts: { k: "text" },
      seen: [{ source: file, digest: "d1" }],
      piiTokens: { f: "1" },
    });
  });
});

describe("#1366: the check before a model call that reads a file", () => {
  it("reads the files with the state's tally and cache, and checks the budgets with the loop's spend", async () => {
    const { node, check } = setup({ withRuntime: true });
    vi.mocked(filePiecesOf).mockImplementation((options) => {
      options.beforeModelCall();
      return Promise.resolve(pieces() as never);
    });
    const state = stateOf({
      inputFiles: [file],
      fileTally: { count: 2, bytes: 5 },
      fileTranscripts: { cached: "t" },
    });

    await node(state, undefined);

    expect(filePiecesOf).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: { name: "runtime" },
        files: [file],
        tally: { count: 2, bytes: 5 },
        cache: { cached: "t" },
        first: 1,
        of: 1,
      }),
    );
    expect(check).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith(
      [record(1, "before"), record(0.5, "loop")],
      ["a"],
      [record(0.5, "loop")],
    );
  });

  it("an exhausted budget refuses the read: the budget's error rises as it is", async () => {
    const { node, check } = setup({ withRuntime: true });
    check.mockImplementation(() => {
      throw new Error("exhausted");
    });
    vi.mocked(filePiecesOf).mockImplementation((options) => {
      options.beforeModelCall();
      return Promise.resolve(pieces() as never);
    });

    const failure = await node(stateOf({ inputFiles: [file] }), undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AgentFailedError);
    expect((failure as AgentFailedError).usage).toEqual([record(0.5, "loop")]);
  });

  it("a step failure, a limit and a PII refusal rise as they are", async () => {
    const { node } = setup({ withRuntime: true });
    const failures = [
      new AgentFailedError({ agent: "other", usage: [], cause: new Error("x") }),
      new LimitExceededError({
        key: "k",
        limit: 1,
        actual: 2,
        path: [],
        spentUsd: usd(0),
        usage: [],
      }),
      new PiiRefusedError({ message: "pii" } as never),
    ];

    for (const failure of failures) {
      vi.mocked(filePiecesOf).mockRejectedValueOnce(failure);
      await expect(node(stateOf({ inputFiles: [file] }), undefined)).rejects.toBe(failure);
    }
  });

  it("any other failure fails the agent with the loop's spend and the cause", async () => {
    const { node } = setup({ withRuntime: true });
    const cause = new Error("down");
    vi.mocked(filePiecesOf).mockRejectedValue(cause);

    const failure = await node(stateOf({ inputFiles: [file] }), undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AgentFailedError);
    expect(failure).toMatchObject({ agent: "alpha", usage: [record(0.5, "loop")] });
    expect((failure as Error).cause).toBe(cause);
  });

  it("an agent with no files, or a state with none, reads none", async () => {
    const bare = setup();
    const withRuntime = setup({ withRuntime: true });

    await bare.node(stateOf({ inputFiles: [file] }), undefined);
    await withRuntime.node(stateOf({ inputFiles: [] }), undefined);

    expect(filePiecesOf).not.toHaveBeenCalled();
  });
});

describe("#1366: the request the input step builds", () => {
  const textOf = (message: unknown): string => (message as { text: string }).text;

  it("an input with nothing in it is `(no input)`", async () => {
    const { node } = setup();

    const out = await node(stateOf({ inputMessage: "" }), undefined);

    expect(listOf(out.messages).map(textOf)).toEqual(["(no input)"]);
  });

  it("the knowledge block is trimmed and joined to the input message after a blank line", async () => {
    const { node } = setup();
    vi.mocked(gatherKnowledge).mockResolvedValue({ block: "  K  \n", records: [] });

    const out = await node(stateOf(), undefined);

    expect(listOf(out.messages).map(textOf)).toEqual(["hello\n\nK"]);
  });

  it("the thread's memory comes first as a message of its own, when there is one", async () => {
    const { node } = setup();
    const memory = {
      summaries: ["a summary"],
      history: [{ start: "start x: 1", finish: "finish y: 2" }],
    };

    const out = await node(stateOf(memory), undefined);

    expect(listOf(out.messages)).toHaveLength(2);
    expect(textOf(listOf(out.messages)[0])).toContain("a summary");
    expect(textOf(listOf(out.messages)[0])).toContain("start x: 1");
    expect(textOf(listOf(out.messages)[1])).toBe("hello");
  });

  it("the guardrails' decisions and spend, and what was masked, are kept with the files'", async () => {
    const { node, tally } = setup({ withRuntime: true, guardrails: ["g"] });
    vi.mocked(loopPoliciesOf).mockReturnValue({
      maskCacheKeyOf: (text: string, isIncoming: boolean) => `key:${text}:${String(isIncoming)}`,
    } as never);
    vi.mocked(maskedModelText).mockResolvedValue({
      text: "masked",
      tokens: { t: "1" },
      usage: [record(0.0625, "masking")],
    });
    vi.mocked(guardedFilesOf).mockResolvedValue({
      files: [],
      usage: [record(0.03125, "views")],
    });
    vi.mocked(fileMaskOf).mockReturnValue({
      maskCacheKeyOf: (text: string) => `file:${text}`,
    } as never);
    vi.mocked(runGuardrails).mockResolvedValue({
      usage: [record(0.5, "guardrail")],
      decisions: ["d1"],
    } as never);
    vi.mocked(filePiecesOf).mockResolvedValue(pieces({ maskedTexts: ["x"], usage: [] }));

    const out = await node(stateOf({ inputFiles: [file] }), undefined);

    expect(out.guardrailDecisions).toEqual(["d1"]);
    expect(out.piiMasked).toEqual({ "key:hello:true": "masked", "file:x": "x" });
    expect(out.piiTokens).toEqual({ t: "1", f: "1" });
    expect(tally.mock.calls[0]?.[0].map((u) => u.caller)).toEqual([
      "rag",
      "masking",
      "views",
      "guardrail",
    ]);
    expect(runGuardrails).toHaveBeenCalledWith(
      ["g"],
      expect.objectContaining({
        component: expect.objectContaining({ name: "alpha" }),
        side: "input",
      }),
      "observer",
    );
  });

  it("without PII policies the input is read as it is and nothing is masked", async () => {
    const { node, tally } = setup({ guardrails: ["g"] });
    vi.mocked(guardedFilesOf).mockResolvedValue({ files: [], usage: [] });
    vi.mocked(runGuardrails).mockResolvedValue({ usage: [], decisions: [] });

    const out = await node(stateOf(), undefined);

    expect(maskedModelText).not.toHaveBeenCalled();
    expect(out.piiMasked).toEqual({});
    expect(vi.mocked(runGuardrails).mock.calls[0]?.[1]).toMatchObject({ text: "hello" });
    // what the guardrails and the views cost is all the input spends of its own, besides the knowledge
    expect(tally.mock.calls[0]?.[0].map((u) => u.caller)).toEqual(["rag"]);
  });
});
