import { usd } from "../../../src/units/index.js";
/**
 * #1366 (budget-flow shard) — the budget rules of the arbiter chain of a branch, each on its own over fakes: a model
 * arbiter's call is checked against the execution's budgets first, with what the chain spent so far; its cost
 * is the chain's; a failed model call and any other failure carry that spend in their `ArbiterError`; a limit
 * passes through as it is; a code arbiter spends nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { judgeAnswer } from "../../../src/flow/runtime/launch/arbiters.js";
import { ArbiterError } from "../../../src/flow/runtime/launch/quorum-errors.js";
import { LimitExceededError } from "../../../src/graph/limits.js";

vi.mock("../../../src/flow/decorators/arbiter.js", () => ({
  arbiterOf: vi.fn((arbiter: { declaration?: unknown }) => arbiter.declaration),
  isCodeArbiter: vi.fn((options: { decidedBy: string }) => options.decidedBy === "code"),
  answerMethodsOf: vi.fn((arbiter: { methods?: unknown }) => arbiter.methods ?? []),
}));
vi.mock("../../../src/flow/decorators/declaration.js", () => ({
  declarationOf: vi.fn((agent: { agentName?: string }) =>
    agent.agentName === undefined ? undefined : { options: { name: agent.agentName } },
  ),
}));

const record = (costUsd: number, caller = "arbiter"): UsageRecord => ({
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
      decidedBy: "model",
      name,
      prompt: "\r\n\r\nCount it.\r\n",
      criteria: [{ agent: Agent, prompt: "\r\n\r\nBe concrete.\r\n" }],
    },
  },
});

const codeArbiter = (name: string, judge: (answer: unknown) => unknown) => ({
  name,
  declaration: { options: { decidedBy: "code", name } },
  methods: [{ agent: Agent, method: "fromSkills" }],
  instance: { fromSkills: judge },
});

const site = { node: "skills-agent", answer: { score: 7 } };

function depsOf(
  models: Record<string, { judge: ReturnType<typeof vi.fn> }>,
  extra: Record<string, unknown> = {},
) {
  // what the chain had spent at each check (the chain's own list grows after it)
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

const step = (...arbiters: object[]) => ({ arbiters }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#1366: a model arbiter's call is checked against the budgets, and its cost is the chain's", () => {
  it("checks with the spend of the arbiters before it, then asks; its usage is added to the chain's", async () => {
    const first = modelArbiter("first-arbiter");
    const second = modelArbiter("second-arbiter");
    const judgeFirst = modelOf({ kind: "judged", passed: true, usage: [record(0.25, "first")] });
    const judgeSecond = modelOf({ kind: "judged", passed: true, usage: [record(0.125, "second")] });
    const { deps, seen } = depsOf({
      "first-arbiter": judgeFirst,
      "second-arbiter": judgeSecond,
    });

    const out = await judgeAnswer([step(first), step(second)] as never, site, deps);

    expect(out).toEqual({
      isAccepted: true,
      rejectedBy: [],
      usage: [record(0.25, "first"), record(0.125, "second")],
    });
    expect(seen).toEqual([[], ["first"]]);
  });

  it("an exhausted budget stops the chain before the model is asked", async () => {
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

    await expect(judgeAnswer([step(arbiter)] as never, site, deps)).rejects.toBe(limit);

    expect(judge.judge).not.toHaveBeenCalled();
  });

  it("asks the model with the agent, its answer and the criterion, both texts normalised", async () => {
    const arbiter = modelArbiter("a-arbiter");
    const judge = modelOf({ kind: "judged", passed: true, usage: [] });
    const reading = { name: "reading" };
    const { deps } = depsOf({ "a-arbiter": judge }, { reading });

    await judgeAnswer([step(arbiter)] as never, site, deps);

    expect(judge.judge).toHaveBeenCalledWith(
      {
        agent: "skills-agent",
        answer: { score: 7 },
        criterion: "Be concrete.",
        instructions: "Count it.",
      },
      reading,
    );
  });

  it("a model that did not answer is an ArbiterError that carries the chain's spend and the call's", async () => {
    const first = modelArbiter("first-arbiter");
    const second = modelArbiter("second-arbiter");
    const { deps } = depsOf({
      "first-arbiter": modelOf({ kind: "judged", passed: true, usage: [record(0.25, "first")] }),
      "second-arbiter": modelOf({
        kind: "failed",
        reason: "timed out",
        usage: [record(0.125, "failed")],
      }),
    });

    const failure = await judgeAnswer([step(first), step(second)] as never, site, deps).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(ArbiterError);
    expect(failure).toMatchObject({ arbiter: "second-arbiter" });
    expect((failure as ArbiterError).usage.map((u) => u.caller)).toEqual(["first", "failed"]);
    expect((failure as Error).cause).toBe("timed out");
  });

  it("a failed call's own cause is the error's", async () => {
    const arbiter = modelArbiter("a-arbiter");
    const cause = new Error("down");
    const { deps } = depsOf({
      "a-arbiter": modelOf({ kind: "failed", reason: "r", cause, usage: [] }),
    });

    const failure = await judgeAnswer([step(arbiter)] as never, site, deps).catch(
      (e: unknown) => e,
    );

    expect((failure as Error).cause).toBe(cause);
  });

  it("a model that throws is an ArbiterError of that arbiter, with the spend so far", async () => {
    const first = modelArbiter("first-arbiter");
    const second = modelArbiter("second-arbiter");
    const { deps } = depsOf({
      "first-arbiter": modelOf({ kind: "judged", passed: true, usage: [record(0.25, "first")] }),
      "second-arbiter": { judge: vi.fn(() => Promise.reject(new Error("boom"))) },
    });

    const failure = await judgeAnswer([step(first), step(second)] as never, site, deps).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(ArbiterError);
    expect(failure).toMatchObject({ arbiter: "second-arbiter" });
    expect((failure as ArbiterError).usage.map((u) => u.caller)).toEqual(["first"]);
  });

  it("an arbiter with no model, or none for the agent, is an ArbiterError before any budget check", async () => {
    const noModel = modelArbiter("none-arbiter");
    const { deps, beforeModelCall } = depsOf({});
    const noCriterion = {
      ...modelArbiter("c-arbiter"),
      declaration: {
        options: { decidedBy: "model", name: "c-arbiter", prompt: "p", criteria: [] },
      },
    };
    const withModel = depsOf({ "c-arbiter": modelOf({ kind: "judged", passed: true, usage: [] }) });

    const missingModel = await judgeAnswer([step(noModel)] as never, site, deps).catch(
      (e: unknown) => e,
    );
    const missingCriterion = await judgeAnswer(
      [step(noCriterion)] as never,
      site,
      withModel.deps,
    ).catch((e: unknown) => e);

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

    await expect(judgeAnswer([step(arbiter)] as never, site, deps)).rejects.toBe(limit);
  });
});

describe("#1366: a code arbiter spends nothing", () => {
  it("accepts or rejects by its method, and no budget is checked", async () => {
    const yes = codeArbiter("yes-arbiter", () => true);
    const no = codeArbiter("no-arbiter", () => false);
    const { deps, beforeModelCall } = depsOf({});

    const accepted = await judgeAnswer([step(yes)] as never, site, deps);
    const rejected = await judgeAnswer([step(no)] as never, site, deps);

    expect(accepted).toEqual({ isAccepted: true, rejectedBy: [], usage: [] });
    expect(rejected).toEqual({ isAccepted: false, rejectedBy: ["no-arbiter"], usage: [] });
    expect(beforeModelCall).not.toHaveBeenCalled();
  });

  it("a method that returns no boolean, or a class that is no arbiter, is an ArbiterError", async () => {
    const odd = codeArbiter("odd-arbiter", () => "yes");
    const { deps } = depsOf({});

    const wrong = await judgeAnswer([step(odd)] as never, site, deps).catch((e: unknown) => e);
    const none = await judgeAnswer([step({ name: "plain" })] as never, site, deps).catch(
      (e: unknown) => e,
    );

    expect(wrong).toBeInstanceOf(ArbiterError);
    expect(none).toBeInstanceOf(ArbiterError);
  });
});

describe("#1366: the chain's order", () => {
  it("anyOf stops at the first that accepts; the first rejection of an AND stops the chain, the spend kept", async () => {
    const reject = modelArbiter("reject-arbiter");
    const accept = modelArbiter("accept-arbiter");
    const never = modelArbiter("never-arbiter");
    const { deps } = depsOf({
      "reject-arbiter": modelOf({ kind: "judged", passed: false, usage: [record(0.25, "reject")] }),
      "accept-arbiter": modelOf({ kind: "judged", passed: true, usage: [record(0.125, "accept")] }),
      "never-arbiter": modelOf({ kind: "judged", passed: true, usage: [record(1, "never")] }),
    });

    const out = await judgeAnswer([step(reject, accept, never)] as never, site, deps);
    const stopped = await judgeAnswer([step(reject), step(never)] as never, site, deps);

    expect(out).toEqual({
      isAccepted: true,
      rejectedBy: [],
      usage: [record(0.25, "reject"), record(0.125, "accept")],
    });
    expect(stopped).toEqual({
      isAccepted: false,
      rejectedBy: ["reject-arbiter"],
      usage: [record(0.25, "reject")],
    });
  });

  it("a launch decided meanwhile ends the chain at once: not accepted, the spend kept", async () => {
    const arbiter = modelArbiter("a-arbiter");
    const controller = new AbortController();
    const judge = {
      judge: vi.fn(() => {
        controller.abort();
        return Promise.resolve({ kind: "judged", passed: true, usage: [record(0.25, "a")] });
      }),
    };
    const { deps } = depsOf({ "a-arbiter": judge }, { signal: controller.signal });

    const out = await judgeAnswer([step(arbiter)] as never, site, deps);

    expect(out).toEqual({ isAccepted: false, rejectedBy: [], usage: [record(0.25, "a")] });
  });

  it("an empty chain accepts", async () => {
    const { deps } = depsOf({});

    expect(await judgeAnswer([], site, deps)).toEqual({
      isAccepted: true,
      rejectedBy: [],
      usage: [],
    });
  });
});

describe("#1366: what is wrong with an arbiter is said", () => {
  const messageOf = async (chain: object[], deps: never): Promise<string> => {
    const failure = await judgeAnswer(chain as never, site, deps).catch((e: unknown) => e);
    return ((failure as Error).cause as Error).message;
  };

  it("an arbiter that has no criterion for the answering agent, no model or is no arbiter says so", async () => {
    const other = { agentName: "other-agent" };
    const arbiter = {
      ...modelArbiter("a-arbiter"),
      declaration: {
        options: {
          decidedBy: "model",
          name: "a-arbiter",
          prompt: "p",
          criteria: [{ agent: other, prompt: "other" }],
        },
      },
    };
    const { deps } = depsOf({ "a-arbiter": modelOf({ kind: "judged", passed: true, usage: [] }) });
    const noModels = depsOf({}, { modelOf: undefined }).deps;

    expect(await messageOf([step(arbiter)], deps)).toBe("no criterion for skills-agent");
    expect(await messageOf([step(modelArbiter("m-arbiter"))], noModels)).toBe(
      "no model for m-arbiter",
    );
    expect(await messageOf([step({ name: "plain" })], deps)).toBe("plain is not an @Arbiter");
  });

  it("the criterion read is the one of the agent that gave the answer, whichever the list's order", async () => {
    const other = { agentName: "other-agent" };
    const arbiter = {
      ...modelArbiter("a-arbiter"),
      declaration: {
        options: {
          decidedBy: "model",
          name: "a-arbiter",
          prompt: "p",
          criteria: [
            { agent: other, prompt: "the other's" },
            { agent: Agent, prompt: "the right one" },
          ],
        },
      },
    };
    const judge = modelOf({ kind: "judged", passed: true, usage: [] });
    const { deps } = depsOf({ "a-arbiter": judge });

    await judgeAnswer([step(arbiter)] as never, site, deps);

    expect(judge.judge).toHaveBeenCalledWith(
      expect.objectContaining({ criterion: "the right one" }),
      undefined,
    );
  });
});

describe("#1366: a code arbiter, and a launch decided while it works", () => {
  const causeOf = async (chain: object[], deps: never): Promise<string> => {
    const failure = await judgeAnswer(chain as never, site, deps).catch((e: unknown) => e);
    return ((failure as ArbiterError).cause as Error).message;
  };

  it("the method of the agent that answered is the one asked, whatever the order of the methods", async () => {
    const other = { agentName: "other-agent" };
    const asked: string[] = [];
    const arbiter = {
      name: "code-arbiter",
      declaration: { options: { decidedBy: "code", name: "code-arbiter" } },
      methods: [
        { agent: other, method: "fromOther" },
        { agent: Agent, method: "fromSkills" },
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

    const out = await judgeAnswer([step(arbiter)] as never, site, deps);

    expect(asked).toEqual(['{"score":7}']);
    expect(out.isAccepted).toBe(true);
  });

  it("an arbiter with no method for the agent, or whose method is none, says so", async () => {
    const { deps } = depsOf({});
    const noMethod = { ...codeArbiter("a-arbiter", () => true), methods: [] };
    const notAFunction = { ...codeArbiter("b-arbiter", () => true), instance: { fromSkills: 1 } };
    const noInstance = { ...codeArbiter("c-arbiter", () => true), instance: undefined };

    expect(await causeOf([step(noMethod)], deps)).toBe("no @OnAnswer method for skills-agent");
    expect(await causeOf([step(notAFunction)], deps)).toBe("fromSkills is not a method");
    expect(await causeOf([step(noInstance)], deps)).toBe("fromSkills is not a method");
    expect(await causeOf([step(codeArbiter("d-arbiter", () => "yes"))], deps)).toBe(
      "fromSkills returned yes, not true or false",
    );
  });

  it("a launch decided before its code arbiter ends: the arbiter is not accepted, and it cost nothing", async () => {
    const controller = new AbortController();
    const arbiter = codeArbiter("slow-arbiter", () => new Promise(() => undefined));
    const { deps } = depsOf({}, { signal: controller.signal });
    const waiting = judgeAnswer([step(arbiter)] as never, site, deps);

    controller.abort();

    expect(await waiting).toEqual({ isAccepted: false, rejectedBy: [], usage: [] });
  });

  it("a launch decided before the check starts abandons it, spending nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const judge = vi.fn(() => true);
    const { deps } = depsOf({}, { signal: controller.signal });

    const out = await judgeAnswer([step(codeArbiter("a-arbiter", judge))] as never, site, deps);

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
      declaration: { options: { decidedBy: "code", name: "code-arbiter" } },
      methods: [{ agent: PlainAgent, method: "fromPlain" }],
      instance: { fromPlain: () => true },
    };
    const { deps } = depsOf({});

    const out = await judgeAnswer(
      [step(arbiter)] as never,
      { node: "PlainAgent", answer: 1 },
      deps,
    );

    expect(out.isAccepted).toBe(true);
  });

  it("a rejection names the arbiter by its declared name, not its class's", async () => {
    const arbiter = {
      name: "ClassName",
      declaration: { options: { decidedBy: "code", name: "declared-name" } },
      methods: [{ agent: Agent, method: "fromSkills" }],
      instance: { fromSkills: () => false },
    };
    const { deps } = depsOf({});

    const out = await judgeAnswer([step(arbiter)] as never, site, deps);

    expect(out.rejectedBy).toEqual(["declared-name"]);
  });

  it("a class that is no arbiter is named by its class's name in the error", async () => {
    const { deps } = depsOf({});

    const failure = await judgeAnswer([step({ name: "PlainClass" })] as never, site, deps).catch(
      (e: unknown) => e,
    );

    expect(failure).toMatchObject({ arbiter: "PlainClass" });
  });
});

describe("#1366: a code arbiter's method, and the launch deciding while it works", () => {
  const codeWith = (instance: unknown) => ({
    name: "code-arbiter",
    declaration: { options: { decidedBy: "code", name: "code-arbiter" } },
    methods: [{ agent: Agent, method: "fromSkills" }],
    instance,
  });
  const causeOf = async (arbiter: object): Promise<string> => {
    const { deps } = depsOf({});
    const failure = await judgeAnswer([step(arbiter)] as never, site, deps).catch(
      (e: unknown) => e,
    );
    return ((failure as Error).cause as Error).message;
  };

  it.each([
    ["an instance that is not there", undefined],
    ["an instance that is null", null],
    ["a method that is no function", { fromSkills: 5 }],
  ])("%s says the method is none", async (_why, instance) => {
    expect(await causeOf(codeWith(instance))).toBe("fromSkills is not a method");
  });

  it("a launch decided before the check ends the chain at once, whatever the check does", async () => {
    const controller = new AbortController();
    controller.abort();
    const hanging = codeWith({ fromSkills: () => new Promise<never>(() => undefined) });
    const { deps } = depsOf({}, { signal: controller.signal });

    const out = await judgeAnswer([step(hanging)] as never, site, deps);

    expect(out).toEqual({ isAccepted: false, rejectedBy: [], usage: [] });
  });

  it("a launch decided while the check works ends the chain at once, and the check's own end is still handled", async () => {
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

    const out = await judgeAnswer([step(hanging)] as never, site, deps);

    expect(out).toEqual({ isAccepted: false, rejectedBy: [], usage: [] });
  });

  it("waits on the launch's signal once, and lets go of it when the check has answered", async () => {
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const { deps } = depsOf({}, { signal: controller.signal });

    await judgeAnswer([step(codeWith({ fromSkills: () => true }))] as never, site, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
  });
});
