import { usd } from "../../../src/units/index.js";
/**
 * #1366 (budget-flow shard) — the budget rules of the arbiter of a branch, each on its own over fakes: a model
 * arbiter's call is checked against the execution's budgets first, with what the check spent so far; its cost
 * is the answer's; a failed model call and any other failure carry that spend in their `ArbiterError`; a limit
 * passes through as it is; a code arbiter spends nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { LiveArbiterModel } from "../../../src/flow/runtime/launch/arbiter-live.js";
import { judgeAnswer } from "../../../src/flow/runtime/launch/arbiters.js";
import { ArbiterError } from "../../../src/flow/runtime/launch/quorum-errors.js";
import { LimitExceededError } from "../../../src/graph/limits.js";

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
  declarationOf: vi.fn((agent: { agentName?: string }) =>
    agent.agentName === undefined ? undefined : { options: { name: agent.agentName } },
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

const Agent = { agentName: "skills-agent" };

/** A model arbiter named `name`, with a criterion for the agent. */
const modelArbiter = (name: string) => ({
  name,
  declaration: {
    options: {
      name,
      prompt: "\r\n\r\nCount it.\r\n",
      criteria: [{ target: Agent, prompt: "\r\n\r\nBe concrete.\r\n" }],
    },
  },
});

const codeArbiter = (name: string, judge: (answer: unknown) => unknown) => ({
  name,
  declaration: { options: { name } },
  methods: [{ targets: [Agent], method: "fromSkills" }],
  instance: { fromSkills: judge },
});

const site = { node: "skills-agent", answer: { score: 7 } };

function depsOf(
  models: Record<string, { judge: ReturnType<typeof vi.fn> }>,
  extra: Record<string, unknown> = {},
) {
  // what the check had spent at each check (the answer's own list grows after it)
  const seen: string[][] = [];
  const beforeModelCall = vi.fn((spent: readonly UsageRecord[]) => {
    seen.push(spent.map((u) => u.caller));
    return Promise.resolve();
  });
  const deps = {
    instanceOf: (arbiter: { instance?: unknown }) => arbiter.instance,
    modelOf: (arbiter: { name: string }) => models[arbiter.name],
    beforeModelCall,
    signal: new AbortController().signal,
    reading: undefined,
    ...extra,
  };
  return { deps: deps as never, beforeModelCall, seen };
}

const modelOf = (verdict: object) => ({ judge: vi.fn(() => Promise.resolve(verdict)) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#1366: a model arbiter's call is checked against the budgets, and its cost is the answer's", () => {
  it("checks the budgets with what the answer spent so far, then asks; its usage is the answer's", async () => {
    const arbiter = modelArbiter("first-arbiter");
    const { deps, seen } = depsOf({
      "first-arbiter": modelOf({ kind: "judged", passed: true, usage: [record(0.25, "first")] }),
    });

    const out = await judgeAnswer(arbiter as never, site, deps);

    expect(out).toEqual({ isAccepted: true, rejectedBy: [], usage: [record(0.25, "first")] });
    expect(seen).toEqual([[]]);
  });

  it("an exhausted budget stops the check before the model is asked", async () => {
    const arbiter = modelArbiter("a-arbiter");
    const judge = modelOf({ kind: "judged", passed: true, usage: [] });
    const { deps, beforeModelCall } = depsOf({ "a-arbiter": judge });
    const limit = new LimitExceededError({
      key: "k",
      limit: 1,
      actual: 2,
      path: [],
      spentUsd: usd(0),
      usage: [],
    });
    beforeModelCall.mockRejectedValue(limit);

    await expect(judgeAnswer(arbiter as never, site, deps)).rejects.toBe(limit);

    expect(judge.judge).not.toHaveBeenCalled();
  });

  it("asks the model with the agent, its answer and the criterion, both texts normalised", async () => {
    const arbiter = modelArbiter("a-arbiter");
    const judge = modelOf({ kind: "judged", passed: true, usage: [] });
    const reading = { name: "reading" };
    const { deps } = depsOf({ "a-arbiter": judge }, { reading });

    await judgeAnswer(arbiter as never, site, deps);

    expect(judge.judge).toHaveBeenCalledWith(
      {
        target: "skills-agent",
        answer: { score: 7 },
        criterion: "Be concrete.",
        instructions: "Count it.",
      },
      reading,
    );
  });

  it("a model that did not answer is an ArbiterError that carries the call's spend", async () => {
    const arbiter = modelArbiter("second-arbiter");
    const { deps } = depsOf({
      "second-arbiter": modelOf({
        kind: "failed",
        reason: "timed out",
        usage: [record(0.125, "failed")],
      }),
    });

    const failure = await judgeAnswer(arbiter as never, site, deps).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ArbiterError);
    expect(failure).toMatchObject({ arbiter: "second-arbiter" });
    expect((failure as ArbiterError).usage.map((u) => u.caller)).toEqual(["failed"]);
    expect((failure as Error).cause).toBe("timed out");
  });

  it("a failed call's own cause is the error's", async () => {
    const arbiter = modelArbiter("a-arbiter");
    const cause = new Error("down");
    const { deps } = depsOf({
      "a-arbiter": modelOf({ kind: "failed", reason: "r", cause, usage: [] }),
    });

    const failure = await judgeAnswer(arbiter as never, site, deps).catch((e: unknown) => e);

    expect((failure as Error).cause).toBe(cause);
  });

  it("a model that throws is an ArbiterError of that arbiter", async () => {
    const arbiter = modelArbiter("second-arbiter");
    const { deps } = depsOf({
      "second-arbiter": { judge: vi.fn(() => Promise.reject(new Error("boom"))) },
    });

    const failure = await judgeAnswer(arbiter as never, site, deps).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ArbiterError);
    expect(failure).toMatchObject({ arbiter: "second-arbiter" });
    expect((failure as ArbiterError).usage).toEqual([]);
  });

  it("an arbiter with no model, or none for the agent, is an ArbiterError before any budget check", async () => {
    const noModel = modelArbiter("none-arbiter");
    const { deps, beforeModelCall } = depsOf({});
    const noCriterion = {
      ...modelArbiter("c-arbiter"),
      declaration: {
        options: { name: "c-arbiter", prompt: "p", criteria: [] },
      },
    };
    const withModel = depsOf({ "c-arbiter": modelOf({ kind: "judged", passed: true, usage: [] }) });

    const missingModel = await judgeAnswer(noModel as never, site, deps).catch((e: unknown) => e);
    const missingCriterion = await judgeAnswer(noCriterion as never, site, withModel.deps).catch(
      (e: unknown) => e,
    );

    expect(missingModel).toBeInstanceOf(ArbiterError);
    expect(missingCriterion).toBeInstanceOf(ArbiterError);
    expect(beforeModelCall).not.toHaveBeenCalled();
    expect(withModel.beforeModelCall).not.toHaveBeenCalled();
  });

  it("a limit or a cancel passes through as it is, never wrapped", async () => {
    const arbiter = modelArbiter("a-arbiter");
    const limit = new LimitExceededError({
      key: "k",
      limit: 1,
      actual: 2,
      path: [],
      spentUsd: usd(0),
      usage: [],
    });
    const { deps } = depsOf({ "a-arbiter": { judge: vi.fn(() => Promise.reject(limit)) } });

    await expect(judgeAnswer(arbiter as never, site, deps)).rejects.toBe(limit);
  });
});

describe("#1366: a code arbiter spends nothing", () => {
  it("accepts or rejects by its method, and no budget is checked", async () => {
    const yes = codeArbiter("yes-arbiter", () => true);
    const no = codeArbiter("no-arbiter", () => false);
    const { deps, beforeModelCall } = depsOf({});

    const accepted = await judgeAnswer(yes as never, site, deps);
    const rejected = await judgeAnswer(no as never, site, deps);

    expect(accepted).toEqual({ isAccepted: true, rejectedBy: [], usage: [] });
    expect(rejected).toEqual({ isAccepted: false, rejectedBy: ["no-arbiter"], usage: [] });
    expect(beforeModelCall).not.toHaveBeenCalled();
  });

  it("a method that returns no boolean, or a class that is no arbiter, is an ArbiterError", async () => {
    const odd = codeArbiter("odd-arbiter", () => "yes");
    const { deps } = depsOf({});

    const wrong = await judgeAnswer(odd as never, site, deps).catch((e: unknown) => e);
    const none = await judgeAnswer({ name: "plain" } as never, site, deps).catch((e: unknown) => e);

    expect(wrong).toBeInstanceOf(ArbiterError);
    expect(none).toBeInstanceOf(ArbiterError);
  });
});

describe("#1366: the arbiter's verdict", () => {
  it("a rejection names the arbiter, its spend kept", async () => {
    const reject = modelArbiter("reject-arbiter");
    const { deps } = depsOf({
      "reject-arbiter": modelOf({ kind: "judged", passed: false, usage: [record(0.25, "reject")] }),
    });

    const out = await judgeAnswer(reject as never, site, deps);

    expect(out).toEqual({
      isAccepted: false,
      rejectedBy: ["reject-arbiter"],
      usage: [record(0.25, "reject")],
    });
  });

  it("a launch decided meanwhile ends the check at once: not accepted, the spend kept", async () => {
    const arbiter = modelArbiter("a-arbiter");
    const controller = new AbortController();
    const judge = {
      judge: vi.fn(() => {
        controller.abort();
        return Promise.resolve({ kind: "judged", passed: true, usage: [record(0.25, "a")] });
      }),
    };
    const { deps } = depsOf({ "a-arbiter": judge }, { signal: controller.signal });

    const out = await judgeAnswer(arbiter as never, site, deps);

    expect(out).toEqual({ isAccepted: false, rejectedBy: [], usage: [record(0.25, "a")] });
  });

  it("a launch without an arbiter counts every answer", async () => {
    const { deps } = depsOf({});

    expect(await judgeAnswer(undefined, site, deps)).toEqual({
      isAccepted: true,
      rejectedBy: [],
      usage: [],
    });
  });
});

describe("#1366: what is wrong with an arbiter is said", () => {
  const messageOf = async (arbiter: object, deps: never): Promise<string> => {
    const failure = await judgeAnswer(arbiter as never, site, deps).catch((e: unknown) => e);
    return ((failure as Error).cause as Error).message;
  };

  it("an arbiter that has no criterion for the answering agent, no model or is no arbiter says so", async () => {
    const other = { agentName: "other-agent" };
    const arbiter = {
      ...modelArbiter("a-arbiter"),
      declaration: {
        options: {
          name: "a-arbiter",
          prompt: "p",
          criteria: [{ target: other, prompt: "other" }],
        },
      },
    };
    const { deps } = depsOf({ "a-arbiter": modelOf({ kind: "judged", passed: true, usage: [] }) });
    const noModels = depsOf({}, { modelOf: undefined }).deps;

    expect(await messageOf(arbiter, deps)).toBe("no criterion for skills-agent");
    expect(await messageOf(modelArbiter("m-arbiter"), noModels)).toBe("no model for m-arbiter");
    expect(await messageOf({ name: "plain" }, deps)).toBe("plain is not an @Arbiter");
  });

  it("the criterion read is the one of the agent that gave the answer, whichever the list's order", async () => {
    const other = { agentName: "other-agent" };
    const arbiter = {
      ...modelArbiter("a-arbiter"),
      declaration: {
        options: {
          name: "a-arbiter",
          prompt: "p",
          criteria: [
            { target: other, prompt: "the other's" },
            { target: Agent, prompt: "the right one" },
          ],
        },
      },
    };
    const judge = modelOf({ kind: "judged", passed: true, usage: [] });
    const { deps } = depsOf({ "a-arbiter": judge });

    await judgeAnswer(arbiter as never, site, deps);

    expect(judge.judge).toHaveBeenCalledWith(
      expect.objectContaining({ criterion: "the right one" }),
      undefined,
    );
  });
});

describe("#1366: a code arbiter, and a launch decided while it works", () => {
  const causeOf = async (arbiter: object, deps: never): Promise<string> => {
    const failure = await judgeAnswer(arbiter as never, site, deps).catch((e: unknown) => e);
    return ((failure as ArbiterError).cause as Error).message;
  };

  it("the method of the agent that answered is the one asked, whatever the order of the methods", async () => {
    const other = { agentName: "other-agent" };
    const asked: string[] = [];
    const arbiter = {
      name: "code-arbiter",
      declaration: { options: { name: "code-arbiter" } },
      methods: [
        { targets: [other], method: "fromOther" },
        { targets: [Agent], method: "fromSkills" },
      ],
      instance: {
        fromOther: () => {
          asked.push("other");
          return false;
        },
        fromSkills: (answer: unknown) => {
          asked.push(JSON.stringify(answer));
          return true;
        },
      },
    };
    const { deps } = depsOf({});

    const out = await judgeAnswer(arbiter as never, site, deps);

    expect(asked).toEqual(['{"score":7}']);
    expect(out.isAccepted).toBe(true);
  });

  it("an arbiter with no method for the agent, or whose method is none, says so", async () => {
    const { deps } = depsOf({});
    const noMethod = { ...codeArbiter("a-arbiter", () => true), methods: [] };
    const notAFunction = { ...codeArbiter("b-arbiter", () => true), instance: { fromSkills: 1 } };
    const noInstance = { ...codeArbiter("c-arbiter", () => true), instance: undefined };

    expect(await causeOf(noMethod, deps)).toBe("no @Arbitrate method for skills-agent");
    expect(await causeOf(notAFunction, deps)).toBe("fromSkills is not a method");
    expect(await causeOf(noInstance, deps)).toBe("fromSkills is not a method");
    expect(
      await causeOf(
        codeArbiter("d-arbiter", () => "yes"),
        deps,
      ),
    ).toBe("fromSkills returned yes, not true or false");
  });

  it("a launch decided before its code arbiter ends: the arbiter is not accepted, and it cost nothing", async () => {
    const controller = new AbortController();
    const arbiter = codeArbiter("slow-arbiter", () => new Promise(() => undefined));
    const { deps } = depsOf({}, { signal: controller.signal });
    const waiting = judgeAnswer(arbiter as never, site, deps);

    controller.abort();

    expect(await waiting).toEqual({ isAccepted: false, rejectedBy: [], usage: [] });
  });

  it("a launch decided before the check starts abandons it, spending nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const judge = vi.fn(() => true);
    const { deps } = depsOf({}, { signal: controller.signal });

    const out = await judgeAnswer(codeArbiter("a-arbiter", judge) as never, site, deps);

    expect(out).toEqual({ isAccepted: false, rejectedBy: [], usage: [] });
  });
});

describe("#1366: the names an arbiter and its agent go by", () => {
  it("an agent that declares no name is known by its class's name", async () => {
    class PlainAgent {
      readonly plain = true;
    }
    const arbiter = {
      name: "code-arbiter",
      declaration: { options: { name: "code-arbiter" } },
      methods: [{ targets: [PlainAgent], method: "fromPlain" }],
      instance: { fromPlain: () => true },
    };
    const { deps } = depsOf({});

    const out = await judgeAnswer(arbiter as never, { node: "PlainAgent", answer: 1 }, deps);

    expect(out.isAccepted).toBe(true);
  });

  it("a rejection names the arbiter by its declared name, not its class's", async () => {
    const arbiter = {
      name: "ClassName",
      declaration: { options: { name: "declared-name" } },
      methods: [{ targets: [Agent], method: "fromSkills" }],
      instance: { fromSkills: () => false },
    };
    const { deps } = depsOf({});

    const out = await judgeAnswer(arbiter as never, site, deps);

    expect(out.rejectedBy).toEqual(["declared-name"]);
  });

  it("a class that is no arbiter is named by its class's name in the error", async () => {
    const { deps } = depsOf({});

    const failure = await judgeAnswer({ name: "PlainClass" } as never, site, deps).catch(
      (e: unknown) => e,
    );

    expect(failure).toMatchObject({ arbiter: "PlainClass" });
  });
});

describe("#1366: a code arbiter's method, and the launch deciding while it works", () => {
  const codeWith = (instance: unknown) => ({
    name: "code-arbiter",
    declaration: { options: { name: "code-arbiter" } },
    methods: [{ targets: [Agent], method: "fromSkills" }],
    instance,
  });
  const causeOf = async (arbiter: object): Promise<string> => {
    const { deps } = depsOf({});
    const failure = await judgeAnswer(arbiter as never, site, deps).catch((e: unknown) => e);
    return ((failure as Error).cause as Error).message;
  };

  it.each([
    ["an instance that is not there", undefined],
    ["an instance that is null", null],
    ["a method that is no function", { fromSkills: 5 }],
  ])("%s says the method is none", async (_why, instance) => {
    expect(await causeOf(codeWith(instance))).toBe("fromSkills is not a method");
  });

  it("a launch decided before the check ends the check at once, whatever the check does", async () => {
    const controller = new AbortController();
    controller.abort();
    const hanging = codeWith({ fromSkills: () => new Promise<never>(() => undefined) });
    const { deps } = depsOf({}, { signal: controller.signal });

    const out = await judgeAnswer(hanging as never, site, deps);

    expect(out).toEqual({ isAccepted: false, rejectedBy: [], usage: [] });
  });

  it("a launch decided while the check works ends the check at once, and the check's own end is still handled", async () => {
    const controller = new AbortController();
    const hanging = codeWith({
      fromSkills: () => {
        queueMicrotask(() => {
          controller.abort();
        });
        return new Promise<never>(() => undefined);
      },
    });
    const { deps } = depsOf({}, { signal: controller.signal });

    const out = await judgeAnswer(hanging as never, site, deps);

    expect(out).toEqual({ isAccepted: false, rejectedBy: [], usage: [] });
  });

  it("waits on the launch's signal once, and lets go of it when the check has answered", async () => {
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const { deps } = depsOf({}, { signal: controller.signal });

    await judgeAnswer(codeWith({ fromSkills: () => true }) as never, site, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
  });
});

describe("#1283: a hybrid arbiter's own model calls are budgeted, charged and kept", () => {
  /** An arbiter whose method calls the current `ArbiterModel` once per `asks`, then answers by `then`. */
  const hybrid = (name: string, method: (model: LiveArbiterModel) => unknown) => {
    const live = new LiveArbiterModel(name);
    return {
      name,
      declaration: { options: { name, deps: [LiveArbiterModel] } },
      methods: [{ targets: [Agent], method: "isCounted" }],
      instance: { isCounted: () => method(live) },
    };
  };

  /** Its models: each `decide` checks the budgets first, then bills `costs[i]`. */
  const modelsOf = (costs: readonly number[], calls: string[] = []) => ({
    judge: vi.fn(),
    metered: (call: { spent: UsageRecord[]; beforeCall: () => Promise<void> }) => {
      let index = 0;
      return {
        model: "m",
        invoke: vi.fn(),
        decide: async () => {
          await call.beforeCall();
          calls.push(`decide#${String(index)}`);
          call.spent.push(record(costs[index] ?? 0, "arbiter:hybrid-arbiter"));
          index += 1;
          return { ok: { type: "boolean", probability: 0.9 } };
        },
      };
    },
  });

  const ask = (live: LiveArbiterModel) => live.decide({ state: "s", questions: {} });

  it("its calls are checked with what the answer spent so far, and billed into the verdict", async () => {
    const arbiter = hybrid("hybrid-arbiter", async (live) => {
      await ask(live);
      await ask(live);
      return true;
    });
    const { deps, seen } = depsOf({ "hybrid-arbiter": modelsOf([0.25, 0.125]) });

    const out = await judgeAnswer(arbiter as never, site, deps);

    expect(out.isAccepted).toBe(true);
    expect(out.usage.map((u) => u.costUsd)).toEqual([0.25, 0.125]);
    expect(seen).toEqual([[], ["arbiter:hybrid-arbiter"]]);
  });

  it("a method that fails after a call is an ArbiterError carrying that call's spend", async () => {
    const arbiter = hybrid("hybrid-arbiter", async (live) => {
      await ask(live);
      throw new Error("not a clear score");
    });
    const { deps } = depsOf({ "hybrid-arbiter": modelsOf([0.25]) });

    const failure = await judgeAnswer(arbiter as never, site, deps).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ArbiterError);
    expect((failure as ArbiterError).usage.map((u) => u.costUsd)).toEqual([0.25]);
  });

  it("a limit that stops its second call passes through, the first call's spend handed to the branch", async () => {
    const arbiter = hybrid("hybrid-arbiter", async (live) => {
      await ask(live);
      await ask(live);
      return true;
    });
    const limit = new LimitExceededError({
      key: "k",
      limit: 1,
      actual: 2,
      path: [],
      spentUsd: usd(0),
      usage: [],
    });
    const kept: UsageRecord[][] = [];
    const { deps, beforeModelCall } = depsOf(
      { "hybrid-arbiter": modelsOf([0.25]) },
      {
        keepSpend: (usage: UsageRecord[]) => {
          kept.push([...usage]);
        },
      },
    );
    beforeModelCall.mockResolvedValueOnce(undefined).mockRejectedValueOnce(limit);

    await expect(judgeAnswer(arbiter as never, site, deps)).rejects.toBe(limit);

    expect(kept.map((usage) => usage.map((u) => u.costUsd))).toEqual([[0.25]]);
  });

  it("a launch decided while its call is out waits for the call's cost, asks no more, and does not count", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const arbiter = hybrid("hybrid-arbiter", async (live) => {
      const first = ask(live);
      controller.abort(); // the quorum is decided while the first call is out
      await first;
      await ask(live); // asks no more
      return true;
    });
    const { deps } = depsOf(
      { "hybrid-arbiter": modelsOf([0.25, 0.5], calls) },
      { signal: controller.signal },
    );

    const out = await judgeAnswer(arbiter as never, site, deps);

    expect(out.isAccepted).toBe(false);
    expect(out.usage.map((u) => u.costUsd)).toEqual([0.25]);
    expect(calls).toEqual(["decide#0"]);
  });

  it("a hybrid arbiter without a model is an ArbiterError before any call", async () => {
    const arbiter = hybrid("hybrid-arbiter", (live) => live.model);
    const { deps, beforeModelCall } = depsOf({});

    const failure = await judgeAnswer(arbiter as never, site, deps).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ArbiterError);
    expect(beforeModelCall).not.toHaveBeenCalled();
  });
});
