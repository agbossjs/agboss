/**
 * #1366 (budget-loop shard) — the budget rules at the loop's approval step, for a question role an agent asks as a
 * tool (#712), each on its own over fakes: before the ask its `maxVisits`, the execution's budgets with the loop's
 * spend, and the holder's fence; an exhausted one asks nobody; the interpreter's spend is the loop's; and a pause
 * that expired fails the step with the spend so far.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { currentFrame } from "../../src/flow/context/frame.js";
import { VisitsLimitExceededError } from "../../src/flow/runtime/errors.js";
import { ComponentKind } from "../../src/flow/runtime/records.js";
import { expiryFailureOf, PauseExpirySignal } from "../../src/flow/runtime/pause-expiry-failure.js";
import { DtoValidationError } from "../../src/dto/errors.js";
import { AgentFailedError } from "../../src/graph/errors.js";
import { makeApprovalNode } from "../../src/graph/agent-loop/approval-node.js";
import { awaitingApproval } from "../../src/graph/agent-loop/boundary.js";

vi.mock("../../src/graph/agent-loop/boundary.js", () => ({ awaitingApproval: vi.fn() }));
vi.mock("../../src/flow/runtime/tool-keys.js", () => ({
  toolRecordOf: vi.fn((tool: { name: string }) => ({ name: tool.name, kind: "tool" })),
}));
vi.mock("../../src/flow/runtime/pause-expiry-failure.js", async (original) => ({
  ...(await original<typeof import("../../src/flow/runtime/pause-expiry-failure.js")>()),
  expiryFailureOf: vi.fn(),
}));
vi.mock("../../src/flow/context/frame.js", async (original) => ({
  ...(await original<typeof import("../../src/flow/context/frame.js")>()),
  currentFrame: vi.fn(),
  inToolCallFrame: vi.fn((_id: unknown, _services: unknown, work: () => unknown) => work()),
}));

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
    questionAnswers: {},
    ...changes,
  }) as never;

const call = { callId: "c1", tool: "ask-tool", args: { q: "?" } };

function setup(options: { maxVisits?: number; asked?: boolean } = {}) {
  const check = vi.fn();
  const assertHeld = vi.fn();
  vi.mocked(currentFrame).mockReturnValue({ execution: { lease: { assertHeld } } } as never);
  const requestAnswer = vi.fn((..._args: unknown[]) =>
    Promise.resolve({ answer: { yes: true }, by: "boss", usage: [record(0.25, "interpreter")] }),
  );
  const tool = {
    name: "ask-tool",
    channel: "ch",
    question: options.maxVisits === undefined ? {} : { maxVisits: options.maxVisits },
    input: { safeParse: (args: unknown) => ({ success: true, data: args }) },
  };
  const deps = {
    agent: { name: "alpha", tools: [tool] },
    budgets: { check },
    approval: { requestAnswer },
  };
  vi.mocked(awaitingApproval).mockReturnValue([call] as never);
  return {
    node: makeApprovalNode(deps as never),
    check,
    assertHeld,
    requestAnswer,
    budgets: deps.budgets,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("#1366: the checks before a question is asked", () => {
  it("checks the budgets with the state's usage, the flow path and the loop's spend, then the fence, then asks", async () => {
    const order: string[] = [];
    const made = setup();
    made.check.mockImplementation(() => order.push("budgets"));
    made.assertHeld.mockImplementation(() => order.push("fence"));
    made.requestAnswer.mockImplementation(() => {
      order.push("ask");
      return Promise.resolve({
        answer: { yes: true },
        by: "b",
        usage: [record(0.25, "interpreter")],
      });
    });

    await made.node(stateOf(), undefined);

    expect(made.check).toHaveBeenCalledWith(
      [record(1, "before"), record(0.5, "loop")],
      ["a"],
      [record(0.5, "loop")],
    );
    expect(order).toEqual(["budgets", "fence", "ask"]);
  });

  it("an exhausted budget asks nobody", async () => {
    const made = setup();
    made.check.mockImplementation(() => {
      throw new Error("exhausted");
    });

    await expect(made.node(stateOf(), undefined)).rejects.toThrow("exhausted");

    expect(made.requestAnswer).not.toHaveBeenCalled();
    expect(made.assertHeld).not.toHaveBeenCalled();
  });

  it("a holder past its lease asks nobody", async () => {
    const made = setup();
    made.assertHeld.mockImplementation(() => {
      throw new Error("lease lost");
    });

    await expect(made.node(stateOf(), undefined)).rejects.toThrow("lease lost");

    expect(made.requestAnswer).not.toHaveBeenCalled();
  });

  it("outside a frame there is no fence to check, and the question is asked", async () => {
    const made = setup();
    vi.mocked(currentFrame).mockReturnValue(undefined);

    await made.node(stateOf(), undefined);

    expect(made.requestAnswer).toHaveBeenCalledOnce();
  });

  it("a role asked as many times as its `maxVisits` in this visit asks no more: the limit carries the spend", async () => {
    const made = setup({ maxVisits: 1 });
    const state = stateOf({ questionAnswers: { c0: { tool: "ask-tool", answer: {} } } });

    const failure = await made.node(state, undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(VisitsLimitExceededError);
    expect(failure).toMatchObject({ maxVisits: 1, path: ["a"], spentUsd: 1.5 });
    expect((failure as VisitsLimitExceededError).component).toMatchObject({ name: "ask-tool" });
    expect(made.check).not.toHaveBeenCalled();
    expect(made.requestAnswer).not.toHaveBeenCalled();
  });

  it.each([
    ["NaN", Number.NaN],
    ["a word", "five"],
    ["an object", { limit: 5 }],
    ["null", null],
    ["a negative number", -1],
    ["a fraction", 1.5],
  ])(
    "#1373: a `maxVisits` that is %s is a bound of 0 — the first question is refused, and the error names no text",
    async (_kind, value) => {
      const made = setup({ maxVisits: value as never });

      const failure = await made.node(stateOf(), undefined).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(VisitsLimitExceededError);
      expect(failure).toMatchObject({ maxVisits: 0, path: ["a"], spentUsd: 1.5 });
      expect((failure as Error).message).not.toContain("five");
      expect(made.check).not.toHaveBeenCalled();
      expect(made.requestAnswer).not.toHaveBeenCalled();
    },
  );

  it("#1373: a `maxVisits` of 0 refuses the first question as well, and a whole number holds as it is", async () => {
    const zero = setup({ maxVisits: 0 });
    const three = setup({ maxVisits: 3 });

    await expect(zero.node(stateOf(), undefined)).rejects.toMatchObject({ maxVisits: 0 });
    await three.node(stateOf(), undefined);

    expect(three.requestAnswer).toHaveBeenCalledOnce();
  });

  it("the role's earlier answers count, another role's do not, and one fewer than the limit is allowed", async () => {
    const made = setup({ maxVisits: 2 });
    const state = stateOf({
      questionAnswers: {
        c0: { tool: "ask-tool", answer: {} },
        c9: { tool: "other-tool", answer: {} },
        c8: { tool: "other-tool", answer: {} },
      },
    });

    await made.node(state, undefined);

    expect(made.requestAnswer).toHaveBeenCalledOnce();
  });

  it("a role with no limit is asked as often as the model calls it", async () => {
    const made = setup();
    const answers = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`c${String(i)}`, { tool: "ask-tool", answer: {} }]),
    );

    await made.node(stateOf({ questionAnswers: answers }), undefined);

    expect(made.requestAnswer).toHaveBeenCalledOnce();
  });
});

describe("#1366: what the question costs", () => {
  it("the interpreter's calls are the loop's spend, the answer is kept by the call's id", async () => {
    const made = setup();

    const out = await made.node(stateOf(), undefined);

    expect(out).toEqual({
      questionAnswers: { c1: { tool: "ask-tool", answer: { yes: true }, by: "boss" } },
      usage: [record(0.25, "interpreter")],
    });
    expect(made.requestAnswer.mock.calls[0]?.slice(0, 3)).toEqual([
      { q: "?" },
      "alpha",
      expect.objectContaining({ name: "ask-tool" }),
    ]);
  });

  it("arguments that are no valid ask ask nobody: no budget check, no spend", async () => {
    const made = setup();
    vi.mocked(awaitingApproval).mockReturnValue([{ ...call, args: {} }] as never);
    const tool = {
      name: "ask-tool",
      channel: "ch",
      question: {},
      input: {
        safeParse: () => ({
          success: false,
          error: { issues: [{ path: ["q"], message: "Required" }] },
        }),
      },
    };
    const deps = {
      agent: { name: "alpha", tools: [tool] },
      budgets: made.budgets,
      approval: { requestAnswer: made.requestAnswer },
    };
    const node = makeApprovalNode(deps as never);

    const out = await node(stateOf(), undefined);

    expect(out).toEqual({
      questionAnswers: { c1: { tool: "ask-tool", problem: "invalid input: q: Required" } },
    });
    expect(made.check).not.toHaveBeenCalled();
    expect(made.requestAnswer).not.toHaveBeenCalled();
  });
});

describe("#1366: what is wrong with a question's arguments is said", () => {
  it("every issue is named by its path and its reason, in the order they were found, and no value", async () => {
    const made = setup();
    vi.mocked(awaitingApproval).mockReturnValue([{ ...call, args: { secret: "x" } }] as never);
    const tool = {
      name: "ask-tool",
      channel: "ch",
      question: {},
      input: {
        safeParse: () => ({
          success: false,
          error: {
            issues: [
              { path: ["q"], message: "Required" },
              { path: ["to", 0], message: "Expected string" },
            ],
          },
        }),
      },
    };
    const deps = {
      agent: { name: "alpha", tools: [tool] },
      budgets: made.budgets,
      approval: { requestAnswer: made.requestAnswer },
    };

    const out = await makeApprovalNode(deps as never)(stateOf(), undefined);

    expect(out).toEqual({
      questionAnswers: {
        c1: { tool: "ask-tool", problem: "invalid input: q: Required; to[0]: Expected string" },
      },
    });
  });
});

describe("#1366: a pause that expired fails the step with the spend so far", () => {
  it("its failure is built from the pause, the step, the execution's spend, the loop's, the path and the budgets", async () => {
    const made = setup();
    const pause = { pauseId: "p1" };
    made.requestAnswer.mockRejectedValue(new PauseExpirySignal(pause as never));
    const built = new Error("expired");
    vi.mocked(expiryFailureOf).mockReturnValue(built);

    const failure = await made.node(stateOf(), undefined).catch((e: unknown) => e);

    expect(failure).toBe(built);
    expect(expiryFailureOf).toHaveBeenCalledWith(pause, {
      step: "alpha",
      stepKind: ComponentKind.Agent,
      state: [record(1, "before"), record(0.5, "loop")],
      usage: [record(0.5, "loop")],
      path: ["a"],
      budgets: made.budgets,
    });
  });
});

describe("#1366: what the checks leave alone", () => {
  it("a role with no `maxVisits` never counts its earlier answers", async () => {
    const made = setup();
    let reads = 0;
    const state = stateOf();
    Object.defineProperty(state, "questionAnswers", {
      get: () => {
        reads += 1;
        return {};
      },
    });

    await made.node(state, undefined);

    expect(reads).toBe(0);
  });

  it("a frame whose execution has no lease has no fence to check", async () => {
    const made = setup();
    vi.mocked(currentFrame).mockReturnValue({ execution: {} } as never);

    await made.node(stateOf(), undefined);

    expect(made.requestAnswer).toHaveBeenCalledOnce();
  });

  it("an answer its channel decided at once that is no valid answer fails the agent with the loop's spend", async () => {
    const made = setup();
    // built bare: its own constructor reads the (faked) frame
    const invalid: DtoValidationError = Object.create(DtoValidationError.prototype);
    made.requestAnswer.mockRejectedValue(invalid);
    vi.mocked(currentFrame).mockReturnValue(undefined);

    const failure = await made.node(stateOf(), undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AgentFailedError);
    expect(failure).toMatchObject({ agent: "alpha", usage: [record(0.5, "loop")] });
    expect((failure as Error).cause).toBe(invalid);
  });
});
