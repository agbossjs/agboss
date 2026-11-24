/**
 * #1366 (budget-flow shard) — the budget rules of the output guardrails on an agent's answer, each on its own over
 * fakes: a file of the answer that is transcribed by a model is checked against the execution's budgets first, with
 * the answer's own spend; and the spend of the masking, of the files' views and of the guardrails is the
 * answer's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { filePiecesOf } from "../../../src/files/visit-files.js";
import { guardedFilesOf } from "../../../src/files/guarded-files.js";
import {
  answerFilesViewed,
  guardedAnswer,
} from "../../../src/flow/runtime/runners/answer-guard.js";
import { carriedRecordsOf } from "../../../src/flow/runtime/carried-records.js";
import { runGuardrails } from "../../../src/guardrails/runtime.js";
import { maskedModelText } from "../../../src/pii/model-boundary.js";

vi.mock("../../../src/files/visit-files.js", () => ({ filePiecesOf: vi.fn() }));
vi.mock("../../../src/files/guarded-files.js", () => ({ guardedFilesOf: vi.fn() }));
vi.mock("../../../src/files/file-mask.js", () => ({ fileMaskOf: vi.fn(() => undefined) }));
vi.mock("../../../src/guardrails/runtime.js", () => ({ runGuardrails: vi.fn() }));
vi.mock("../../../src/pii/model-boundary.js", () => ({ maskedModelText: vi.fn() }));

const record = (costUsd: number, caller = "x"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

const stateOf = () => ({ usage: [record(1, "state")], path: ["a"] }) as never;

function setup() {
  const check = vi.fn();
  const reading = { runtime: { maxResultSize: 1000, name: "runtime" }, budgets: { check } };
  vi.mocked(filePiecesOf).mockImplementation((options) => {
    options.beforeModelCall();
    return Promise.resolve({ viewed: ["view"], usage: [record(0.25, "pieces")] } as never);
  });
  vi.mocked(guardedFilesOf).mockResolvedValue({
    files: ["guarded"],
    usage: [record(0.125, "guard")],
  } as never);
  return { check, reading };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(guardedFilesOf);
});

const file = (id: string, url?: string, sha256?: string) => ({ fileId: id, url, sha256 });

describe("#1366: the files of an answer", () => {
  it("are read by number from the answer, once each, and what they cost is the answer's", async () => {
    const { reading } = setup();
    const result = {
      answerFiles: [file("f1"), file("f1"), file("f2")],
      fileTranscripts: { cached: "t" },
      usage: [record(0.5, "answer")],
    };

    const out = await answerFilesViewed("alpha", result as never, {
      reading: reading as never,
      state: stateOf(),
      mask: undefined,
    });

    expect(filePiecesOf).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: reading.runtime,
        tally: { count: 0, bytes: 0 },
        cache: { cached: "t" },
        first: 1,
        of: 2,
      }),
    );
    expect(vi.mocked(filePiecesOf).mock.calls[0]?.[0].files.map((f) => f.field)).toEqual([
      "answer file 1",
      "answer file 2",
    ]);
    expect(vi.mocked(filePiecesOf).mock.calls[0]?.[0].files[0]).toMatchObject({
      producer: "the agent's answer",
    });
    expect(out.usage.map((u) => u.caller)).toEqual(["pieces", "guard"]);
    expect(out.files).toEqual(["guarded"]);
  });

  it("a file with no url and one with an empty one are the same file; one digest apart are two", async () => {
    const { reading } = setup();
    const result = {
      answerFiles: [
        file("f1"),
        { fileId: "f1", url: "", sha256: undefined },
        file("f1", undefined, "h"),
        file("f1", undefined, "g"),
      ],
      fileTranscripts: {},
      usage: [],
    };

    await answerFilesViewed("alpha", result as never, {
      reading: reading as never,
      state: stateOf(),
      mask: undefined,
    });

    expect(vi.mocked(filePiecesOf).mock.calls[0]?.[0].of).toBe(3);
  });

  it("a file with no id, no url or no digest is the same as one whose field is empty", async () => {
    const { reading } = setup();
    const result = {
      answerFiles: [
        { url: "u" },
        { fileId: "", url: "u" },
        { fileId: "a" },
        { fileId: "a", sha256: "" },
      ],
      fileTranscripts: {},
      usage: [],
    };

    await answerFilesViewed("alpha", result as never, {
      reading: reading as never,
      state: stateOf(),
      mask: undefined,
    });

    expect(vi.mocked(filePiecesOf).mock.calls[0]?.[0].of).toBe(2);
  });

  it("files that differ in url or digest are different files", async () => {
    const { reading } = setup();
    const result = {
      answerFiles: [file("f1", "u1"), file("f1", "u2"), file("f1", "u1", "h")],
      fileTranscripts: {},
      usage: [],
    };

    await answerFilesViewed("alpha", result as never, {
      reading: reading as never,
      state: stateOf(),
      mask: undefined,
    });

    expect(vi.mocked(filePiecesOf).mock.calls[0]?.[0].of).toBe(3);
  });

  it("checks the budgets before a transcription's model call, with the state's usage, the step's path and the answer's spend", async () => {
    const { reading, check } = setup();
    const result = {
      answerFiles: [file("f1")],
      fileTranscripts: {},
      usage: [record(0.5, "answer")],
    };

    await answerFilesViewed("alpha", result as never, {
      reading: reading as never,
      state: stateOf(),
      mask: undefined,
    });

    expect(check).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith(
      [record(1, "state")],
      ["a", "alpha"],
      [record(0.5, "answer")],
    );
  });

  it("an exhausted budget refuses the read", async () => {
    const { reading, check } = setup();
    check.mockImplementation(() => {
      throw new Error("exhausted");
    });
    const result = { answerFiles: [file("f1")], fileTranscripts: {}, usage: [] };

    await expect(
      answerFilesViewed("alpha", result as never, {
        reading: reading as never,
        state: stateOf(),
        mask: undefined,
      }),
    ).rejects.toThrow("exhausted");

    expect(guardedFilesOf).not.toHaveBeenCalled();
  });

  it("an answer with no files, or nothing to read them with, reads none", async () => {
    const { reading } = setup();
    const none = { answerFiles: [], fileTranscripts: {}, usage: [] };

    const empty = await answerFilesViewed("alpha", none, {
      reading: reading as never,
      state: stateOf(),
      mask: undefined,
    });
    const noRuntime = await answerFilesViewed(
      "alpha",
      { ...none, answerFiles: [file("f1")] } as never,
      {
        reading: undefined,
        state: stateOf(),
        mask: undefined,
      },
    );

    expect(empty).toEqual({ files: [], usage: [] });
    expect(noRuntime).toEqual({ files: [], usage: [] });
    expect(filePiecesOf).not.toHaveBeenCalled();
  });

  it("the guarded views are bounded by the runtime's result size and masked as the agent's model reads", async () => {
    const { reading } = setup();
    const mask = { mask: true };

    await answerFilesViewed(
      "alpha",
      { answerFiles: [file("f1")], fileTranscripts: {}, usage: [] } as never,
      {
        reading: reading as never,
        state: stateOf(),
        mask: mask as never,
      },
    );

    expect(guardedFilesOf).toHaveBeenCalledWith(["view"], 1000, mask);
    expect(vi.mocked(filePiecesOf).mock.calls[0]?.[0].mask).toBe(mask);
  });
});

describe("#1366: the output guardrails' spend is the answer's", () => {
  const passed = { usage: [record(0.0625, "guardrail")], decisions: ["d"] };
  const pii = { loop: { values: {}, key: "k" }, tokens: {} } as never;
  const resultOf = (changes: object = {}) =>
    ({ reply: "text", answerFiles: [], fileTranscripts: {}, usage: [], ...changes }) as never;

  it("without guardrails nothing is read or spent", async () => {
    const out = await guardedAnswer(
      "alpha",
      resultOf(),
      pii,
      { guardrails: { outputOf: () => [] } } as never,
      {
        reading: undefined,
        state: stateOf(),
      },
    );

    expect(out).toEqual({ usage: [], decisions: [] });
    expect(runGuardrails).not.toHaveBeenCalled();
  });

  it("an agent with no guardrail list at all has none either", async () => {
    const out = await guardedAnswer("alpha", resultOf(), pii, {} as never, {
      reading: undefined,
      state: stateOf(),
    });

    expect(out).toEqual({ usage: [], decisions: [] });
  });

  it("the masking's, the files' and the guardrails' spend are the answer's, in that order, with the decisions", async () => {
    const { reading } = setup();
    vi.mocked(runGuardrails).mockResolvedValue(passed as never);
    const set = {
      withValues: () => set,
      withFieldKey: () => set,
    };
    vi.mocked(maskedModelText).mockResolvedValue({
      text: "masked",
      tokens: {},
      usage: [record(0.5, "masking")],
    });
    const deps = {
      guardrails: { outputOf: () => ["g"] },
      pii: { policiesOf: () => set },
      observer: "observer",
    };

    const out = await guardedAnswer(
      "alpha",
      resultOf({ answerFiles: [file("f1")] }),
      pii,
      deps as never,
      { reading: reading as never, state: stateOf() },
    );

    expect(out.usage.map((u) => u.caller)).toEqual(["masking", "pieces", "guard", "guardrail"]);
    expect(out.decisions).toEqual(["d"]);
    expect(runGuardrails).toHaveBeenCalledWith(
      ["g"],
      expect.objectContaining({ text: "masked", element: "alpha", side: "output" }),
      "observer",
    );
  });

  it("without PII policies the reply is read as it is and masking costs nothing", async () => {
    vi.mocked(runGuardrails).mockResolvedValue({ usage: [], decisions: [] });
    vi.mocked(guardedFilesOf).mockResolvedValue({ files: [], usage: [] });

    const out = await guardedAnswer(
      "alpha",
      resultOf(),
      pii,
      { guardrails: { outputOf: () => ["g"] } } as never,
      {
        reading: undefined,
        state: stateOf(),
      },
    );

    expect(maskedModelText).not.toHaveBeenCalled();
    expect(vi.mocked(runGuardrails).mock.calls[0]?.[1]).toMatchObject({ text: "text" });
    expect(out.usage).toEqual([]);
  });

  it("a block of the guardrails carries the answer's records with its failure", async () => {
    const blocked = new Error("blocked");
    vi.mocked(runGuardrails).mockRejectedValue(blocked);

    const failure = await guardedAnswer(
      "alpha",
      resultOf({ toolCalls: ["t"], judgeVerdicts: ["j"], guardrailDecisions: ["d"] }),
      pii,
      { guardrails: { outputOf: () => ["g"] } } as never,
      { reading: undefined, state: stateOf() },
    ).catch((e: unknown) => e);

    expect(failure).toBe(blocked);
    expect(carriedRecordsOf(failure)).toMatchObject({
      toolCalls: ["t"],
      judgeVerdicts: ["j"],
      guardrailDecisions: ["d"],
    });
  });
});
