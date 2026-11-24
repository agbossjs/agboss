/**
 * #1366 (budget-loop shard) — the budget rules of the quality gate after an agent's reply, each on its own over
 * fakes: what the judges' models cost is counted at once (#338) and the budgets' tallied form is the loop's
 * spend, whichever way the gate ends — a pass, a send-back for a retry, or a `QualityGateError`, which carries it.
 */
import { StreamDiscardReason } from "../../src/run/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { makeJudgeNode } from "../../src/graph/agent-loop/judge-node.js";
import { QualityGateError } from "../../src/graph/errors.js";
import { agentStreamOf } from "../../src/run/stream/agent-stream.js";
import { carriedRecordsOf } from "../../src/flow/runtime/carried-records.js";
import { meteredModel } from "../../src/graph/agent-loop/judge-model.js";
import { judgedFilesOf } from "../../src/graph/agent-loop/judge-files.js";
import { AgentFailedError } from "../../src/graph/errors.js";
import { reportNodeEvent } from "../../src/flow/observers/execution-event.js";

vi.mock("../../src/graph/agent-loop/judge-model.js", () => ({ meteredModel: vi.fn() }));
vi.mock("../../src/graph/agent-loop/judge-files.js", () => ({
  judgedFilesOf: vi.fn(() => Promise.resolve({ files: [], pieces: [], usage: [] })),
}));
vi.mock("../../src/flow/observers/execution-event.js", () => ({
  reportNodeEvent: vi.fn((work: (base: object) => unknown) =>
    Promise.resolve(work({ base: true })).then(() => undefined),
  ),
}));
vi.mock("../../src/run/stream/agent-stream.js", () => ({ agentStreamOf: vi.fn() }));
vi.mock("../../src/graph/agent-loop/model-pii.js", () => ({
  loopPoliciesOf: vi.fn(() => undefined),
}));

/** A list an update gives: a plain one or an overwrite of one. */
const listOf = <T>(value: readonly T[] | object | undefined): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

const record = (costUsd: number, caller = "x"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

const stateOf = (changes: Record<string, unknown> = {}) =>
  ({
    runId: "run-1",
    usage: [record(1, "before"), record(0.5, "loop")],
    from: { usage: 1 },
    flowPath: ["a"],
    reply: "the reply",
    answer: null,
    retries: 0,
    inputMessage: "task",
    trajectory: [],
    piiTokens: {},
    ...changes,
  }) as never;

/** A judge whose model costs `cost` and whose verdict is `verdict`. */
const judgeOf = (name: string, verdict: { passed: boolean; reason?: string }) => ({
  name,
  handler: { judge: vi.fn(() => Promise.resolve(verdict)) },
});

function setup(
  judges: object[],
  options: { maxRetries?: unknown; unset?: true; observer?: object } = {},
) {
  const tally = vi.fn((records: readonly UsageRecord[], _path?: readonly string[]) =>
    records.map((r) => ({ ...r, tallied: true })),
  );
  // each judge's model call costs 0.25, recorded on the list the node hands it
  vi.mocked(meteredModel).mockImplementation(((_judge: unknown, usage: UsageRecord[]) => {
    usage.push(record(0.25, "judge"));
    return {};
  }) as never);
  const deps = {
    agent: {
      name: "alpha",
      judges,
      ...(options.unset === true
        ? {}
        : { maxRetries: "maxRetries" in options ? options.maxRetries : 1 }),
      answerTools: { tools: [], isList: false, hasVariants: false },
    },
    budgets: { tally },
    observer: options.observer,
  };
  return { node: makeJudgeNode(deps as never), tally };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(reportNodeEvent).mockImplementation((work: (base: never) => unknown) =>
    Promise.resolve(work({ base: true } as never)).then(() => undefined),
  );
  vi.mocked(judgedFilesOf).mockResolvedValue({ files: [], pieces: [], usage: [] });
});

describe("#1366: the quality gate counts what the judges cost", () => {
  it("a reply that passes: the judges' spend is tallied on the flow path and is the loop's, tallied", async () => {
    const { node, tally } = setup([
      judgeOf("j1", { passed: true }),
      judgeOf("j2", { passed: true }),
    ]);

    const out = await node(stateOf(), undefined);

    expect(tally).toHaveBeenCalledOnce();
    expect(tally.mock.calls[0]?.[0].map((u) => u.costUsd)).toEqual([0.25, 0.25]);
    expect(tally.mock.calls[0]?.[1]).toEqual(["a"]);
    expect(listOf(out.usage).every((u) => (u as { tallied?: boolean }).tallied === true)).toBe(
      true,
    );
    expect(out.usage).toHaveLength(2);
    expect(listOf<{ passed: boolean }>(out.judgeVerdicts).map((v) => v.passed)).toEqual([
      true,
      true,
    ]);
    expect(Object.keys(out)).not.toContain("reply");
  });

  it("no judge, or no reply yet, is no gate: nothing is asked or counted", async () => {
    const none = setup([]);
    const early = setup([judgeOf("j1", { passed: true })]);

    expect(await none.node(stateOf(), undefined)).toEqual({});
    expect(await early.node(stateOf({ reply: null }), undefined)).toEqual({});

    expect(none.tally).not.toHaveBeenCalled();
    expect(early.tally).not.toHaveBeenCalled();
  });

  it("a rejection with a retry left sends the reply back: its reason is read by the model, the spend is kept", async () => {
    const { node } = setup([judgeOf("j1", { passed: false, reason: "too long" })]);

    const out = await node(stateOf({ retries: 0 }), undefined);

    expect(out).toMatchObject({
      reply: null,
      answer: null,
      answeredWith: [],
      answerFiles: [],
      retries: 1,
    });
    expect(out.usage).toHaveLength(1);
    expect((listOf<{ text: string }>(out.messages)[0] ?? { text: "" }).text).toContain(
      "- [j1] too long",
    );
    expect(out.judgeVerdicts).toHaveLength(1);
  });

  it("a rejection with no retry left is a QualityGateError that carries the loop's spend and this round's judges", async () => {
    const { node } = setup([judgeOf("j1", { passed: false, reason: "too long" })], {
      maxRetries: 1,
    });

    const failure = await node(stateOf({ retries: 1 }), undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(QualityGateError);
    expect(failure).toMatchObject({
      retries: 1,
      rejections: [{ judge: "j1", reason: "too long" }],
    });
    expect((failure as QualityGateError).usage.map((u) => u.costUsd)).toEqual([0.5, 0.25]);
    expect((failure as QualityGateError).usage[1]).toMatchObject({ tallied: true });
  });

  it("an agent that is allowed no retry fails at the first rejection", async () => {
    const { node } = setup([judgeOf("j1", { passed: false, reason: "no" })], { maxRetries: 0 });

    await expect(node(stateOf({ retries: 0 }), undefined)).rejects.toBeInstanceOf(QualityGateError);
  });

  it("#1373: an agent with no `maxRetries` set is allowed no retry", async () => {
    const { node } = setup([judgeOf("j1", { passed: false, reason: "no" })], { unset: true });

    await expect(node(stateOf({ retries: 0 }), undefined)).rejects.toBeInstanceOf(QualityGateError);
  });

  it.each([
    ["NaN", Number.NaN],
    ["a word", "five"],
    ["an object", { retries: 5 }],
    ["null", null],
    ["a negative number", -1],
    ["a fraction", 1.5],
  ])(
    "#1373: a `maxRetries` that is %s is no retry, never endless ones: the first rejection fails",
    async (_kind, value) => {
      const { node } = setup([judgeOf("j1", { passed: false, reason: "no" })], {
        maxRetries: value,
      });

      await expect(node(stateOf({ retries: 0 }), undefined)).rejects.toBeInstanceOf(
        QualityGateError,
      );
    },
  );

  it("every judge runs even when one rejects: all their spend is counted", async () => {
    const { node, tally } = setup(
      [judgeOf("j1", { passed: false, reason: "a" }), judgeOf("j2", { passed: true })],
      { maxRetries: 3 },
    );

    const out = await node(stateOf(), undefined);

    expect(tally.mock.calls[0]?.[0]).toHaveLength(2);
    expect(out.judgeVerdicts).toHaveLength(2);
  });
});

describe("#1366: what a rejection retracts and carries", () => {
  it("the text the reply streamed is retracted whether a retry follows or the agent fails", async () => {
    const discardLast = vi.fn();
    vi.mocked(agentStreamOf).mockReturnValue({ discardLast } as never);
    const retry = setup([judgeOf("j1", { passed: false, reason: "no" })], { maxRetries: 1 });
    const fail = setup([judgeOf("j1", { passed: false, reason: "no" })], { maxRetries: 0 });

    await retry.node(stateOf({ retries: 0 }), undefined);
    await fail.node(stateOf({ retries: 0 }), undefined).catch(() => undefined);

    expect(discardLast).toHaveBeenCalledTimes(2);
    expect(discardLast).toHaveBeenCalledWith(StreamDiscardReason.JudgeRejected);
  });

  it("a reply that passes is not retracted", async () => {
    const discardLast = vi.fn();
    vi.mocked(agentStreamOf).mockReturnValue({ discardLast } as never);
    const { node } = setup([judgeOf("j1", { passed: true })]);

    await node(stateOf(), undefined);

    expect(discardLast).not.toHaveBeenCalled();
  });

  it("the QualityGateError carries this round's verdicts", async () => {
    const { node } = setup([judgeOf("j1", { passed: false, reason: "no" })], { maxRetries: 0 });

    const failure = await node(stateOf(), undefined).catch((e: unknown) => e);

    expect(carriedRecordsOf(failure).judgeVerdicts).toHaveLength(1);
    expect(carriedRecordsOf(failure).judgeVerdicts[0]).toMatchObject({
      passed: false,
      reason: "no",
    });
  });

  it("an agent with no judges at all has no gate", async () => {
    const tally = vi.fn();
    const deps = { agent: { name: "alpha", answerTools: {} }, budgets: { tally } };

    const out = await makeJudgeNode(deps as never)(stateOf(), undefined);

    expect(out).toEqual({});
    expect(tally).not.toHaveBeenCalled();
  });
});

describe("#1366: the spend of the files the judges read, and of a judge that broke", () => {
  it("what reading the files the judges are shown cost is counted with their models', before them", async () => {
    const { node, tally } = setup([judgeOf("j1", { passed: true })]);
    vi.mocked(judgedFilesOf).mockResolvedValue({
      files: [],
      pieces: [],
      usage: [record(0.125, "files")],
    });

    await node(stateOf(), undefined);

    expect(tally.mock.calls[0]?.[0].map((u) => u.caller)).toEqual(["files", "judge"]);
  });

  it("a judge that broke fails the agent with the loop's spend, the files' and its model's so far", async () => {
    const broke = {
      name: "j1",
      handler: { judge: vi.fn(() => Promise.reject(new Error("model down"))) },
    };
    const { node } = setup([broke]);
    vi.mocked(judgedFilesOf).mockResolvedValue({
      files: [],
      pieces: [],
      usage: [record(0.125, "files")],
    });

    const failure = await node(stateOf(), undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AgentFailedError);
    expect((failure as AgentFailedError).usage.map((u) => u.caller)).toEqual([
      "loop",
      "files",
      "judge",
    ]);
    expect((failure as AgentFailedError).cause).toEqual(new Error("model down"));
  });

  it("the observer hears each judge start with the reply and end with its verdict", async () => {
    const onJudgeStart = vi.fn();
    const onJudgeEnd = vi.fn();
    const { node } = setup([judgeOf("j1", { passed: false, reason: "too long" })], {
      observer: { onJudgeStart, onJudgeEnd, onAgentRetry: vi.fn() },
    });

    await node(stateOf(), undefined);

    expect(onJudgeStart).toHaveBeenCalledWith({
      base: true,
      judge: "j1",
      agent: "alpha",
      input: "the reply",
    });
    expect(onJudgeEnd).toHaveBeenCalledWith({
      base: true,
      judge: "j1",
      agent: "alpha",
      output: { passed: false, reason: "too long" },
    });
  });

  it("a gate with no observer is heard by none, and passes", async () => {
    const { node } = setup([judgeOf("j1", { passed: true })]);

    await expect(node(stateOf(), undefined)).resolves.toBeDefined();
  });
});
