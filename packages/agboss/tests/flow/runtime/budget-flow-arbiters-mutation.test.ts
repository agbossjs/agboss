/**
 * #1356 (budget-flow shard) — the arbiter of a branch, rule by rule over fakes: the answer a code arbiter's method reads
 * is the answer as its target gave it, tracked (a text agent's reply as its `{ text }` class); the method judging a
 * target is found among the targets of any method; only an arbiter that has a model is given one; what the observer is
 * told of who judges; a failed judging hands its spend to the branch only when a limit or a cancel ended it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StepError } from "../../../src/core/error-families/step-errors.js";
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import { WorkflowFinishTextDto } from "../../../src/dto/standard/framework.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { judgeAnswer } from "../../../src/flow/runtime/launch/arbiters.js";
import { observedJudging } from "../../../src/flow/runtime/launch/arbiter-events.js";
import { Metadata } from "../../../src/flow/metadata.js";
import { usd } from "../../../src/units/index.js";

vi.mock("../../../src/flow/decorators/arbiter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/flow/decorators/arbiter.js")>()),
  arbiterOf: vi.fn((arbiter: { declaration?: unknown }) => arbiter.declaration),
  isCodeArbiter: vi.fn((options: { criteria?: unknown }) => options.criteria === undefined),
  hasArbiterModel: vi.fn(
    (options: { criteria?: unknown; deps?: unknown[] }) =>
      options.criteria !== undefined || (options.deps ?? []).length > 0,
  ),
  answerMethodsOf: vi.fn((arbiter: { methods?: unknown }) => arbiter.methods ?? []),
}));
vi.mock("../../../src/flow/decorators/declaration.js", () => ({
  declarationOf: vi.fn((target: { agentName?: string; kind?: unknown; output?: unknown }) =>
    target.agentName === undefined
      ? undefined
      : { kind: target.kind, options: { name: target.agentName, output: target.output } },
  ),
}));
vi.mock("../../../src/flow/runtime/launch/arbiter-events.js", () => ({
  observedJudging: vi.fn((_about: unknown, _usage: unknown, judge: () => Promise<unknown>) =>
    judge(),
  ),
}));

const record = (costUsd: number, caller = "arbiter"): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const SkillsAgent = { agentName: "skills-agent" };
const TextAgent = { agentName: "text-agent", kind: ComponentKind.Agent, output: undefined };
const TypedAgent = { agentName: "typed-agent", kind: ComponentKind.Agent, output: {} };
const OtherAgent = { agentName: "other-agent" };

/** A code arbiter whose method for `targets` hands what it was given to `seen`. */
const codeArbiter = (targets: object[], seen: unknown[], extra: object = {}) => ({
  name: "desk-arbiter",
  declaration: { options: { name: "desk-arbiter", ...extra } },
  methods: [{ targets, method: "judge" }],
  instance: {
    judge: (answer: unknown) => {
      seen.push(answer);
      return true;
    },
  },
});

function depsOf(extra: Record<string, unknown> = {}) {
  const deps = {
    instanceOf: (arbiter: { instance?: unknown }) => arbiter.instance,
    beforeModelCall: vi.fn(() => Promise.resolve()),
    signal: new AbortController().signal,
    reading: undefined,
    ...extra,
  };
  return deps as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#1356: the answer a code arbiter's method reads", () => {
  it("an object answer is tracked as given by its target, and keeps its data", async () => {
    const seen: unknown[] = [];
    const answer = { score: 7 };

    await judgeAnswer(
      codeArbiter([SkillsAgent], seen) as never,
      { node: "skills-agent", answer },
      depsOf(),
    );

    expect(seen).toEqual([{ score: 7 }]);
    expect(Metadata.has(seen[0] as object)).toBe(true);
    expect(Metadata.of(seen[0] as object)?.createdBy).toBe(SkillsAgent);
  });

  it("an answer that is tracked already is the one the method gets, as it is", async () => {
    const seen: unknown[] = [];
    const answer = Metadata.with({ score: 7 }, { createdBy: OtherAgent as never });

    await judgeAnswer(
      codeArbiter([SkillsAgent], seen) as never,
      { node: "skills-agent", answer },
      depsOf(),
    );

    expect(seen[0]).toBe(answer);
    expect(Metadata.of(seen[0] as object)?.createdBy).toBe(OtherAgent);
  });

  it.each([
    ["a text", "plain words"],
    ["a number", 7],
    ["nothing", null],
    ["no answer", undefined],
  ])("%s is read as it is, never tracked", async (_why, answer) => {
    const seen: unknown[] = [];

    await judgeAnswer(
      codeArbiter([SkillsAgent], seen) as never,
      { node: "skills-agent", answer },
      depsOf(),
    );

    expect(seen).toEqual([answer]);
  });

  it("the reply of a text agent is its `{ text }` class, the data kept; an agent with an output keeps the plain data; another's reply is not one", async () => {
    const seenText: unknown[] = [];
    const seenTyped: unknown[] = [];
    const seenOther: unknown[] = [];
    const known = Object.assign(Object.create(WorkflowFinishTextDto.prototype) as object, {
      text: "known",
    });
    const seenKnown: unknown[] = [];

    await judgeAnswer(
      codeArbiter([TextAgent], seenText) as never,
      { node: "text-agent", answer: { text: "hi" } },
      depsOf(),
    );
    await judgeAnswer(
      codeArbiter([TypedAgent], seenTyped) as never,
      { node: "typed-agent", answer: { text: "hi" } },
      depsOf(),
    );
    await judgeAnswer(
      codeArbiter([SkillsAgent], seenOther) as never,
      { node: "skills-agent", answer: { text: "hi" } },
      depsOf(),
    );
    await judgeAnswer(
      codeArbiter([TextAgent], seenKnown) as never,
      { node: "text-agent", answer: known },
      depsOf(),
    );

    expect(seenText[0]).toBeInstanceOf(WorkflowFinishTextDto);
    expect(seenText[0]).toMatchObject({ text: "hi" });
    expect(seenTyped[0]).not.toBeInstanceOf(WorkflowFinishTextDto);
    expect(seenOther[0]).not.toBeInstanceOf(WorkflowFinishTextDto);
    expect(Metadata.of(seenText[0] as object)?.createdBy).toBe(TextAgent);
    expect(seenKnown[0]).toStrictEqual(known);
  });

  it("a target with no declaration is known by its class's name, and its answer is still tracked as its own", async () => {
    class Plain {
      readonly kind = "plain";
    }
    const seen: unknown[] = [];

    await judgeAnswer(
      codeArbiter([Plain], seen) as never,
      { node: "Plain", answer: { a: 1 } },
      depsOf(),
    );

    expect(Metadata.of(seen[0] as object)?.createdBy).toBe(Plain);
    expect(seen[0]).not.toBeInstanceOf(WorkflowFinishTextDto);
  });

  it("a method for several targets is found by any of them, and the answer is tracked as given by the one that answered", async () => {
    const seen: unknown[] = [];
    const arbiter = codeArbiter([OtherAgent, SkillsAgent], seen);

    const out = await judgeAnswer(
      arbiter as never,
      { node: "skills-agent", answer: { score: 1 } },
      depsOf(),
    );

    expect(out.isAccepted).toBe(true);
    expect(Metadata.of(seen[0] as object)?.createdBy).toBe(SkillsAgent);
  });

  it("a method of other targets alone is no method for the answer", async () => {
    const seen: unknown[] = [];

    const failure = await judgeAnswer(
      codeArbiter([OtherAgent], seen) as never,
      { node: "skills-agent", answer: {} },
      depsOf(),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StepError.Arbiter);
    expect(((failure as StepError.Arbiter).cause as Error).message).toBe(
      "no @Arbitrate method for skills-agent",
    );
    expect(seen).toEqual([]);
  });
});

describe("#1356: which arbiter is given a model", () => {
  it("one that declares no model is given none, though the launch holds one for it", async () => {
    const seen: unknown[] = [];
    const modelOf = vi.fn(() => ({ metered: vi.fn() }));

    const out = await judgeAnswer(
      codeArbiter([SkillsAgent], seen) as never,
      { node: "skills-agent", answer: {} },
      depsOf({ modelOf }),
    );

    expect(out.isAccepted).toBe(true);
    expect(modelOf).not.toHaveBeenCalled();
  });

  it("one that declares a model, in a launch that holds none for it, runs as a code arbiter", async () => {
    const seen: unknown[] = [];

    const out = await judgeAnswer(
      codeArbiter([SkillsAgent], seen, { deps: ["ArbiterModel"] }) as never,
      { node: "skills-agent", answer: { a: 1 } },
      depsOf(),
    );

    expect(out).toEqual({ isAccepted: true, rejectedBy: [], usage: [] });
    expect(seen).toHaveLength(1);
  });
});

describe("#1356: what the observer is told of who judges", () => {
  const aboutOf = () => vi.mocked(observedJudging).mock.calls[0]?.[0];

  it("a code arbiter, its declared name and the node it judges", async () => {
    await judgeAnswer(
      codeArbiter([SkillsAgent], []) as never,
      { node: "skills-agent", answer: {} },
      depsOf(),
    );

    expect(aboutOf()).toStrictEqual({
      arbiter: "desk-arbiter",
      target: "skills-agent",
      isCode: true,
    });
  });

  it("a model arbiter is told as one that is no code", async () => {
    const arbiter = {
      name: "model-arbiter",
      declaration: {
        options: { name: "model-arbiter", criteria: [{ target: SkillsAgent, prompt: "p" }] },
      },
    };
    const models = {
      "model-arbiter": {
        instructions: "i",
        judge: vi.fn(() => Promise.resolve({ kind: "judged", passed: true, usage: [] })),
      },
    };

    await judgeAnswer(
      arbiter as never,
      { node: "skills-agent", answer: {} },
      depsOf({ modelOf: (one: { name: string }) => models[one.name as keyof typeof models] }),
    );

    expect(aboutOf()).toStrictEqual({
      arbiter: "model-arbiter",
      target: "skills-agent",
      isCode: false,
    });
  });

  it("a class that is no arbiter counts as code", async () => {
    class Stranger {
      readonly kind = "stranger";
    }

    await judgeAnswer(Stranger as never, { node: "skills-agent", answer: {} }, depsOf()).catch(
      () => undefined,
    );

    expect(aboutOf()).toStrictEqual({ arbiter: "Stranger", target: "skills-agent", isCode: true });
  });
});

describe("#1356: the spend of a judging a limit or a cancel ended", () => {
  const limit = () =>
    new LimitError.Agent({ key: "k", limit: 1, actual: 2, path: [], spentUsd: usd(0), usage: [] });

  it("is handed to the branch when a limit ended it", async () => {
    const keepSpend = vi.fn();
    const arbiter = {
      name: "model-arbiter",
      declaration: {
        options: { name: "model-arbiter", criteria: [{ target: SkillsAgent, prompt: "p" }] },
      },
    };
    const spent = record(0.25, "first");
    const stop = limit();
    const deps = depsOf({
      keepSpend,
      beforeModelCall: vi.fn(() => Promise.reject(stop)),
      modelOf: () => ({ instructions: "i", judge: vi.fn() }),
    });
    vi.mocked(observedJudging).mockImplementationOnce(async (_about, usage, judge) => {
      (usage as UsageRecord[]).push(spent);
      return judge();
    });

    await expect(
      judgeAnswer(arbiter as never, { node: "skills-agent", answer: {} }, deps),
    ).rejects.toBe(stop);

    expect(keepSpend).toHaveBeenCalledWith([spent]);
  });

  it("is not handed over when the arbiter failed on its own: the failure carries it", async () => {
    const keepSpend = vi.fn();
    const arbiter = codeArbiter([SkillsAgent], []);
    arbiter.instance.judge = () => {
      throw new Error("the arbiter crashed");
    };

    await expect(
      judgeAnswer(arbiter as never, { node: "skills-agent", answer: {} }, depsOf({ keepSpend })),
    ).rejects.toBeInstanceOf(StepError.Arbiter);

    expect(keepSpend).not.toHaveBeenCalled();
  });
});
