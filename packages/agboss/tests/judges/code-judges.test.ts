/**
 * #396 PR 1 — `@Judge({ decidedBy: DecidedBy.Code })`: a judge decided by its `judge(input)` alone,
 * in an agent's quality gate beside a model judge (its services and the execution through `deps`,
 * no model call, no spend), refused at assembly with a model (`[judge.model-on-code-judge]`) or an
 * injected `JudgeModel`, and run by `testJudge` without a model script.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { Application } from "../../src/application/application.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { PlainTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Agent,
  DecidedBy,
  EmptyEnvironment,
  Judge,
  JudgeModel,
  JudgeVerdict,
  QualityGateError,
  Workflow,
  type JudgeHandler,
} from "../../src/index.js";
import { replyWith, testJudge, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { offline } from "../components/fixture/deps-contract.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute, start } from "../helpers/flow.js";
import {
  NoBannedWordsJudge,
  PromiseAgent,
  PromiseDeskApplication,
  PromiseFinish,
  PromiseStart,
  SecondOpinionJudge,
} from "./fixtures/code-judges.workflow.js";
import { DEFAULTS, Grounded } from "./fixtures/judged.workflow.js";

describe("#396: a code judge in an agent's quality gate", () => {
  const test = testWith(PromiseDeskApplication);

  test("rejects by code, its reason goes back for the retry; no model call, no spend of its own", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(PromiseAgent)
      .thenReturn(replyWith("We guarantee it.", { cost: usd(0.002) }))
      .thenReturn(replyWith("We will try.", { cost: usd(0.002) }));
    mockLlm(Grounded)
      .thenReturn(replyWith("PASS", { cost: usd(0.0005) }))
      .thenReturn(replyWith("PASS", { cost: usd(0.0005) }));

    const result = await execute(app, PromiseStart, { text: "will it arrive?" });

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.output).toEqual({ text: "We will try." });
    const [, second] = mockLlm(PromiseAgent).requests;
    expect(JSON.stringify(second)).toContain("[no-banned-words-judge] never say guarantee");
    expect(result.spend.trace.map((line) => line.caller)).not.toContain(
      "judge:no-banned-words-judge",
    );
    expect(result.spend.totalUsd).toBeCloseTo(0.005, 6);
  });

  test("a code judge that keeps rejecting ends the run with QualityGateError", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(PromiseAgent).thenReturnAlways(replyWith("A guarantee."));
    mockLlm(Grounded).thenReturnAlways(replyWith("PASS"));

    await expect(execute(app, PromiseStart, { text: "?" })).rejects.toBeInstanceOf(
      QualityGateError,
    );
  });

  test("mockLlm on a code judge names why: it calls no model", ({ mockLlm }) => {
    expect(() => mockLlm(NoBannedWordsJudge)).toThrow(/a code judge calls no model/u);
  });
});

// @ts-expect-error -- a code judge takes no model ([judge.model-on-code-judge] for plain JS)
@Judge({
  name: "named-model-judge",
  decidedBy: DecidedBy.Code,
  model: "local/judge",
  reply: PlainTextDto,
})
class NamedModelJudge implements JudgeHandler<PlainTextDto> {
  judge(): Promise<JudgeVerdict> {
    return Promise.resolve(JudgeVerdict.passed());
  }
}

@Judge({
  name: "injected-model-judge",
  decidedBy: DecidedBy.Code,
  reply: PlainTextDto,
  deps: [JudgeModel],
})
class InjectedModelJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge(): Promise<JudgeVerdict> {
    return (await this.judgeModel.invoke("ok?")) === "yes"
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed({ reason: "no" });
  }
}

/** One application whose only agent is gated by `judge`. */
function gatedBy(judge: typeof NamedModelJudge | typeof InjectedModelJudge, name: string) {
  @Agent({
    name: `${name}-agent`,
    prompt: "Write.",
    description: "Gated",
    model: "local/llama",
    judges: [judge],
  })
  class GatedAgent {}

  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(PromiseStart).returns(WorkflowStartTextDto).toAgent(GatedAgent).toFinish(PromiseFinish),
    ],
    defaults: DEFAULTS,
  })
  class GatedWorkflow {}

  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [GatedWorkflow],
    budgets: TEST_BUDGETS,
  })
  class GatedApplication {}

  return GatedApplication;
}

describe("#396: [judge.model-on-code-judge] at assembly", () => {
  it("a code judge that names a model is refused", async () => {
    await expect(createApp(gatedBy(NamedModelJudge, "named"), offline())).rejects.toThrow(
      /^\[judge\.model-on-code-judge\] @Judge NamedModelJudge \("named-model-judge"\): decided by code \(DecidedBy\.Code\), but it names model "local\/judge"/u,
    );
  });

  it("a code judge that injects JudgeModel is refused", async () => {
    await expect(createApp(gatedBy(InjectedModelJudge, "injected"), offline())).rejects.toThrow(
      /^\[judge\.model-on-code-judge\] @Judge InjectedModelJudge .*remove JudgeModel from deps/u,
    );
  });

  it("decidedBy and model are discriminated: a model judge needs a model, a code judge none", () => {
    // @ts-expect-error -- a model judge (the default) names its model
    Judge({ name: "a-judge", reply: PlainTextDto });
    // @ts-expect-error -- DecidedBy.Model names its model too
    Judge({ name: "b-judge", decidedBy: DecidedBy.Model, reply: PlainTextDto });
    // @ts-expect-error -- DecidedBy.Code takes no model
    Judge({ name: "c-judge", decidedBy: DecidedBy.Code, model: "x", reply: PlainTextDto });

    expect(Judge({ name: "d-judge", decidedBy: DecidedBy.Code, reply: PlainTextDto })).toBeTypeOf(
      "function",
    );
  });
});

describe("#396: testJudge on a code judge", () => {
  it("runs judge(input) alone in the execution's frame: its verdict, no spend", async () => {
    const run = testJudge(NoBannedWordsJudge, { tenant: { tenantId: "acme" } });

    const passed = await run({
      variant: PlainTextDto,
      reply: { text: "We will try." },
      task: "?",
      attempt: 0,
    });
    const failed = await run({
      variant: PlainTextDto,
      reply: { text: "We guarantee." },
      task: "?",
      attempt: 1,
    });

    expect(passed.output).toEqual(JudgeVerdict.passed({ metrics: { words: 3, tenantId: "acme" } }));
    expect(passed.spend).toMatchObject({ calls: 0, totalUsd: 0, trace: [] });
    expect(failed.output).toEqual(JudgeVerdict.failed({ reason: "never say guarantee" }));
  });

  it("a model script for a code judge is a mistake in the test", () => {
    expect(() => testJudge(NoBannedWordsJudge, { model: replyWith("PASS") })).toThrow(
      /no-banned-words-judge is decided by code \(DecidedBy\.Code\) — it calls no model; leave out model/u,
    );
  });

  it("the same assembly rules: a code judge with a model is refused", () => {
    expect(() => testJudge(NamedModelJudge)).toThrow(/^\[judge\.model-on-code-judge\]/u);
  });

  it("a model reached through a service is refused, naming the judge and the call", async () => {
    const run = testJudge(SecondOpinionJudge);

    const { output } = await run({
      variant: PlainTextDto,
      reply: { text: "x" },
      task: "?",
      attempt: 0,
    });

    const reasons = output.passed ? [] : output.reason.split(" | ");
    expect(reasons).toEqual(
      ["invoke", "decide", "model"].map(
        (member) =>
          `[judge.model-on-code-judge] judge "second-opinion-judge" is decided by code (DecidedBy.Code) and has no model — judgeModel.${member} is not available`,
      ),
    );
  });
});
