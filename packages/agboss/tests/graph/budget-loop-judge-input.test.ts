import { usd } from "../../src/units/index.js";
/**
 * #1366 (budget-loop shard) — what a judge of the quality gate reads and what the gate records, each rule on its own
 * over fakes: the shape of the input by the shape of the answer — a text, one value with its answer tool's class, a list
 * of one class or of several —, a copy for every judge, an answer that does not match its answer tools refused, the
 * verdicts' records (the reason of a rejection, the metrics a judge reports) and the text sent back for a retry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { PlainTextDto } from "../../src/dto/standard/framework.js";
import { listOf, oneOf } from "../../src/flow/dto-wrappers.js";
import { judgedFilesOf } from "../../src/graph/agent-loop/judge-files.js";
import { meteredModel } from "../../src/graph/agent-loop/judge-model.js";
import { loopPoliciesOf } from "../../src/graph/agent-loop/model-pii.js";
import { modelReadingMaskOf } from "../../src/pii/model-boundary.js";
import { BudgetExceededError } from "../../src/graph/limits.js";
import { makeJudgeNode, retryPrompt } from "../../src/graph/agent-loop/judge-node.js";
import { reportNodeEvent } from "../../src/flow/observers/execution-event.js";

vi.mock("../../src/graph/agent-loop/judge-model.js", () => ({ meteredModel: vi.fn(() => ({})) }));
vi.mock("../../src/graph/agent-loop/judge-files.js", () => ({ judgedFilesOf: vi.fn() }));
vi.mock("../../src/flow/observers/execution-event.js", () => ({ reportNodeEvent: vi.fn() }));
vi.mock("../../src/run/stream/agent-stream.js", () => ({ agentStreamOf: vi.fn() }));
vi.mock("../../src/graph/agent-loop/model-pii.js", () => ({ loopPoliciesOf: vi.fn() }));
vi.mock("../../src/pii/model-boundary.js", () => ({ modelReadingMaskOf: vi.fn() }));

class ADto {
  readonly a = true;
}
class BDto {
  readonly b = true;
}

const record = (costUsd: number): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller: "judge",
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const FILES = [{ name: "f" }];

const stateOf = (changes: Record<string, unknown> = {}) =>
  ({
    runId: "run-1",
    usage: [],
    from: { usage: 0 },
    flowPath: ["a"],
    reply: "the reply",
    answer: null,
    answeredWith: [],
    retries: 2,
    inputMessage: "task",
    trajectory: [{ call: 1 }],
    piiTokens: {},
    ...changes,
  }) as never;

interface Verdict {
  passed: boolean;
  reason?: string;
  metrics?: object;
}

/** A judge of `reply`, which says `verdict` and keeps what it was asked. */
const judgeOf = (name: string, reply: unknown, verdict: Verdict = { passed: true }) => {
  const asked: unknown[] = [];
  return {
    asked,
    judge: {
      name,
      output: reply,
      handler: {
        judge: vi.fn((input: unknown) => {
          asked.push(input);
          return Promise.resolve(verdict);
        }),
      },
    },
  };
};

const check = vi.fn();

function nodeOf(
  judges: object[],
  answerTools: { tools: { dto: unknown }[]; isList: boolean; hasVariants: boolean },
) {
  const deps = {
    agent: { name: "alpha", judges, maxRetries: 3, answerTools },
    budgets: { tally: (records: readonly UsageRecord[]) => records, check },
  };
  return makeJudgeNode(deps as never);
}

const single = { tools: [{ dto: ADto }], isList: false, hasVariants: false };
const many = { tools: [{ dto: ADto }, { dto: BDto }], isList: true, hasVariants: false };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(meteredModel).mockImplementation(((_judge: unknown, usage: UsageRecord[]) => {
    usage.push(record(0.25));
    return {};
  }) as never);
  vi.mocked(judgedFilesOf).mockResolvedValue({ files: FILES, pieces: [], usage: [] } as never);
  vi.mocked(reportNodeEvent).mockResolvedValue(undefined);
  vi.mocked(loopPoliciesOf).mockReturnValue(undefined);
  vi.mocked(modelReadingMaskOf).mockReturnValue(undefined);
});

describe("#1290: the budgets are checked before each model call of a judge", () => {
  it("the check a judge's model runs before a call has the loop's spend and the judges' so far, on the flow path", async () => {
    const { judge } = judgeOf("j", PlainTextDto);
    const earlier = record(0.5);

    await nodeOf([judge], single)(
      stateOf({ usage: [earlier], from: { usage: 0 }, flowPath: ["a", "b"] }),
      undefined,
    );
    const beforeCall = vi.mocked(meteredModel).mock.calls[0]?.[4];
    expect(beforeCall).toBeTypeOf("function");
    expect(check).not.toHaveBeenCalled();
    await beforeCall?.();

    // the judge's own spend so far (the mock pushed 0.25) joins the state's records
    expect(check).toHaveBeenCalledTimes(1);
    const [state, path, usage] = check.mock.calls[0] ?? [];
    expect(state).toEqual([earlier, expect.objectContaining({ costUsd: 0.25 })]);
    expect(path).toEqual(["a", "b"]);
    expect(usage).toEqual(expect.arrayContaining([expect.objectContaining({ costUsd: 0.25 })]));
  });

  it("a spent budget the check throws is the run's error as it is; any other throw fails the agent", async () => {
    const spent = Object.create(BudgetExceededError.prototype) as BudgetExceededError;
    const other = new Error("a judge's own throw");
    const { judge } = judgeOf("j", PlainTextDto);

    judge.handler.judge.mockImplementationOnce(() => {
      throw spent;
    });
    await expect(nodeOf([judge], single)(stateOf(), undefined)).rejects.toBe(spent);

    judge.handler.judge.mockImplementationOnce(() => {
      throw other;
    });
    await expect(nodeOf([judge], single)(stateOf(), undefined)).rejects.toMatchObject({
      name: "AgentFailedError",
      cause: other,
    });
  });
});

describe("#1366: what a judge reads of the answer", () => {
  it("a reply that is no answer of a tool is a text, with the task, the attempt, the visit's tool calls and the files", async () => {
    const { judge, asked } = judgeOf("j", PlainTextDto);

    await nodeOf([judge], single)(stateOf(), undefined);

    expect(asked).toEqual([
      {
        task: "task",
        attempt: 2,
        toolCalls: [{ call: 1 }],
        files: FILES,
        variant: PlainTextDto,
        output: { text: "the reply" },
      },
    ]);
  });

  it("one value is read as its answer tool's class, and each judge reads its own copy", async () => {
    const first = judgeOf("j1", ADto);
    const second = judgeOf("j2", ADto);
    const value = { a: { deep: 1 } };

    await nodeOf([first.judge, second.judge], single)(
      stateOf({ answer: { value }, answeredWith: [0] }),
      undefined,
    );

    const [one] = first.asked as { variant: unknown; output: unknown }[];
    const [two] = second.asked as { output: unknown }[];
    expect(one?.variant).toBe(ADto);
    expect(one?.output).toEqual(value);
    expect(one?.output).not.toBe(value);
    expect(two?.output).not.toBe(one?.output);
  });

  it("an answer by a tool that is not among the agent's is refused, naming the position", async () => {
    const { judge } = judgeOf("j", ADto);

    await expect(
      nodeOf([judge], single)(stateOf({ answer: { value: {} }, answeredWith: [4] }), undefined),
    ).rejects.toThrow(new TypeError("alpha: no answer tool at position 4"));
  });

  it("an answer with no answer tool at all is refused", async () => {
    const { judge } = judgeOf("j", ADto);

    await expect(
      nodeOf([judge], single)(stateOf({ answer: { value: {} }, answeredWith: [] }), undefined),
    ).rejects.toThrow(new TypeError("alpha: an answer without a class"));
  });

  it("a list of one class is read as its items in that class", async () => {
    const { judge, asked } = judgeOf("j", listOf(ADto));
    const tools = { tools: [{ dto: ADto }], isList: true, hasVariants: false };

    await nodeOf([judge], tools)(
      stateOf({ answer: { value: [{ n: 1 }, { n: 2 }] }, answeredWith: [0, 0] }),
      undefined,
    );

    expect(asked[0]).toMatchObject({ variant: ADto, output: [{ n: 1 }, { n: 2 }] });
  });

  it("an answer that is no list has no items", async () => {
    const { judge, asked } = judgeOf("j", listOf(ADto));
    const tools = { tools: [{ dto: ADto }], isList: true, hasVariants: false };

    await nodeOf([judge], tools)(
      stateOf({ answer: { value: "text" }, answeredWith: [] }),
      undefined,
    );

    expect(asked[0]).toMatchObject({ variant: ADto, output: [] });
  });

  it("a list of several classes, judged as one class: the judge's own class, whether it names the list or the class", async () => {
    const byList = judgeOf("j1", listOf(ADto));
    const byClass = judgeOf("j2", ADto);

    await nodeOf([byList.judge, byClass.judge], many)(
      stateOf({ answer: { value: [{ n: 1 }] }, answeredWith: [0] }),
      undefined,
    );

    expect(byList.asked[0]).toMatchObject({ variant: ADto, output: [{ n: 1 }] });
    expect(byClass.asked[0]).toMatchObject({ variant: ADto, output: [{ n: 1 }] });
  });

  it("a list of several classes whose judge names no one class is refused", async () => {
    const { judge } = judgeOf("j", listOf(oneOf(ADto, BDto)));
    const tools = { ...many, hasVariants: false };
    const asked = judgeOf("k", oneOf(ADto, BDto));

    await expect(
      nodeOf([asked.judge], tools)(stateOf({ answer: { value: [] }, answeredWith: [] }), undefined),
    ).rejects.toThrow(new TypeError("a list judge of one class has one class"));
    expect(judge.handler.judge).not.toHaveBeenCalled();
  });

  it("the items of a list that holds several classes are their values, whatever else they carry", async () => {
    const { judge, asked } = judgeOf("j", listOf(ADto));
    const tools = { ...many, hasVariants: true };

    await nodeOf([judge], tools)(
      stateOf({
        answer: { value: [{ variant: "A", value: { n: 1 } }, 7, null] },
        answeredWith: [0, 1, 1],
      }),
      undefined,
    );

    expect(asked[0]).toMatchObject({ variant: ADto, output: [{ n: 1 }, 7, null] });
  });

  it("a judge of a list of several classes reads each item with its own class", async () => {
    const { judge, asked } = judgeOf("j", listOf(oneOf(ADto, BDto)));
    const tools = { ...many, hasVariants: true };

    await nodeOf([judge], tools)(
      stateOf({
        answer: {
          value: [
            { variant: "A", value: { n: 1 } },
            { variant: "B", value: { n: 2 } },
          ],
        },
        answeredWith: [0, 1],
      }),
      undefined,
    );

    const [input] = asked as { output: unknown }[];
    expect(input?.output).toEqual([
      { variant: ADto, value: { n: 1 } },
      { variant: BDto, value: { n: 2 } },
    ]);
    expect(Object.keys(input ?? {})).not.toContain("variant");
  });

  it("an item with no answer tool of its class is refused, naming its index", async () => {
    const { judge } = judgeOf("j", listOf(oneOf(ADto, BDto)));
    const tools = { ...many, hasVariants: true };

    await expect(
      nodeOf([judge], tools)(
        stateOf({ answer: { value: [{ value: 1 }, { value: 2 }] }, answeredWith: [0] }),
        undefined,
      ),
    ).rejects.toThrow(new TypeError("no answer tool for item 1"));
  });
});

describe("#1366: a judge's model reads as the agent's model does", () => {
  it("through the agent's PII policies and the tokens it holds: its masking, its pieces and the spend list it is metered on", async () => {
    const policies = { policies: true };
    const mask = { mask: true };
    vi.mocked(loopPoliciesOf).mockReturnValue(policies as never);
    vi.mocked(modelReadingMaskOf).mockReturnValue(mask as never);
    vi.mocked(judgedFilesOf).mockResolvedValue({ files: FILES, pieces: ["p"], usage: [] } as never);
    const { judge } = judgeOf("j", PlainTextDto);

    await nodeOf([judge], single)(stateOf({ piiTokens: { t: "1" } }), undefined);

    expect(modelReadingMaskOf).toHaveBeenCalledWith(policies, { t: "1" });
    expect(meteredModel).toHaveBeenCalledWith(
      judge,
      expect.any(Array),
      mask,
      ["p"],
      expect.any(Function),
    );
  });
});

describe("#1366: what the gate records of a verdict, and sends back", () => {
  const verdictsOf = async (verdict: Verdict) => {
    const { judge } = judgeOf("quality-judge", PlainTextDto, verdict);
    const out = await nodeOf([judge], single)(stateOf({ retries: 0 }), undefined);
    return (out.judgeVerdicts ?? []) as { reason?: string; metrics?: object; passed: boolean }[];
  };

  it("a pass has no reason, and the metrics a judge reports are kept with it", async () => {
    const [kept] = await verdictsOf({ passed: true, metrics: { score: 0.9 } });

    expect(kept).toMatchObject({ passed: true, attempt: 0, metrics: { score: 0.9 } });
    expect(Object.keys(kept ?? {})).not.toContain("reason");
  });

  it("a verdict with no metrics has no metrics key, and a rejection keeps its reason", async () => {
    const [kept] = await verdictsOf({ passed: false, reason: "too long" });

    expect(kept).toMatchObject({ passed: false, reason: "too long" });
    expect(Object.keys(kept ?? {})).not.toContain("metrics");
  });

  it("the text sent back names every rejecting judge and its reason, under the one line that says why", () => {
    expect(
      retryPrompt([
        { judge: "j1", reason: "too long" },
        { judge: "j2", reason: "rude" },
      ]),
    ).toBe(
      "Your reply did not pass the quality gate. Fix the following and reply again:\n- [j1] too long\n- [j2] rude",
    );
  });
});
