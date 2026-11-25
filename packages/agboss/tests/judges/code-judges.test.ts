/**
 * #396 PR 1 — `@Judge({ })`: a judge decided by its `judge(input)` alone,
 * in an agent's quality gate beside a model judge (its services and the execution through `deps`,
 * no model call, no spend), refused at assembly with a model (`[judge.model-on-code-judge]`) or an
 * injected `JudgeModel`, and run by `testUnit` without a model script.
 */
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { PlainTextDto } from "../../src/dto/index.js";
import {
  Agent,
  EmptyEnvironment,
  Judge,
  JudgeModel,
  JudgeVerdict,
  QualityGateError,
  Workflow,
  type JudgeHandler,
  inline,
  Ttl,
} from "../../src/index.js";
import { replyWith, testUnit, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { offline } from "../components/fixture/deps-contract.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute, onStart } from "../helpers/flow.js";
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
    mockModel,
  }) => {
    mockModel(PromiseAgent)
      .thenReturn(replyWith("We guarantee it.", { cost: usd(0.002) }))
      .thenReturn(replyWith("We will try.", { cost: usd(0.002) }));
    mockModel(Grounded)
      .thenReturn(replyWith("PASS", { cost: usd(0.0005) }))
      .thenReturn(replyWith("PASS", { cost: usd(0.0005) }));

    const result = await execute(app, PromiseStart, { text: "will it arrive?" });

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.output).toEqual({ text: "We will try." });
    const [, second] = mockModel(PromiseAgent).requests;
    expect(JSON.stringify(second)).toContain("[no-banned-words-judge] never say guarantee");
    expect(result.spend.trace.map((line) => line.caller)).not.toContain(
      "judge:no-banned-words-judge",
    );
    expect(result.spend.totalUsd).toBeCloseTo(0.005, 6);
  });

  test("a code judge that keeps rejecting ends the run with QualityGateError", async ({
    app,
    mockModel,
  }) => {
    mockModel(PromiseAgent).thenReturnAlways(replyWith("A guarantee."));
    mockModel(Grounded).thenReturnAlways(replyWith("PASS"));

    await expect(execute(app, PromiseStart, { text: "?" })).rejects.toBeInstanceOf(
      QualityGateError,
    );
  });

  test("mockModel on a code judge names why: it calls no model", ({ mockModel }) => {
    expect(() => mockModel(NoBannedWordsJudge)).toThrow(/a code judge calls no model/u);
  });
});

// @ts-expect-error -- a code judge takes no model ([judge.model-on-code-judge] for plain JS)
@Judge({
  name: "named-model-judge",
  model: "local/judge",
  output: PlainTextDto,
})
class NamedModelJudge implements JudgeHandler<PlainTextDto> {
  judge(): Promise<JudgeVerdict> {
    return Promise.resolve(JudgeVerdict.passed());
  }
}

/** One application whose only agent is gated by `judge`. */
function gatedBy(judge: typeof NamedModelJudge, name: string) {
  @Agent({
    name: `${name}-agent`,
    prompt: inline("Write."),
    description: "Gated",
    model: "local/llama",
    judges: [judge],
  })
  class GatedAgent {}

  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(PromiseStart).toAgent(GatedAgent).toFinish(PromiseFinish)],
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

/** A class that is no judge model provider: a `modelProvider` of a judge with no `JudgeModel` does not compile. */
class SomeProvider {
  readonly name = "some-provider";
}

describe("#396: [judge.model-on-code-judge] at assembly", () => {
  it("a code judge that names a model is refused", async () => {
    await expect(createTestAppWith(gatedBy(NamedModelJudge, "named"), offline())).rejects.toThrow(
      /^\[judge\.model-on-code-judge\] @Judge NamedModelJudge \("named-model-judge"\): names a model, but it does not inject JudgeModel/u,
    );
  });

  it("model and modelProvider need JudgeModel in deps", () => {
    // @ts-expect-error -- a judge with no JudgeModel in deps is decided by code: it names no model
    Judge({ name: "a-judge", model: "x", output: PlainTextDto });
    // @ts-expect-error -- nor a modelProvider
    Judge({ name: "b-judge", modelProvider: SomeProvider, output: PlainTextDto });

    expect(Judge({ name: "c-judge", output: PlainTextDto })).toBeTypeOf("function");
    expect(
      Judge({ name: "d-judge", model: "x", output: PlainTextDto, deps: [JudgeModel] }),
    ).toBeTypeOf("function");
  });
});

describe("#396: testUnit on a code judge", () => {
  it("runs judge(input) alone in the execution's frame: its verdict, no spend", async () => {
    const run = testUnit(NoBannedWordsJudge, { tenant: { tenantId: "acme" } });

    const passed = await run({
      variant: PlainTextDto,
      output: { text: "We will try." },
      task: "?",
      attempt: 0,
    });
    const failed = await run({
      variant: PlainTextDto,
      output: { text: "We guarantee." },
      task: "?",
      attempt: 1,
    });

    expect(passed.output).toEqual(JudgeVerdict.passed({ metrics: { words: 3, tenantId: "acme" } }));
    expect(passed.spend).toMatchObject({ calls: 0, totalUsd: usd(0), trace: [] });
    expect(failed.output).toEqual(JudgeVerdict.failed("never say guarantee"));
  });

  it("a model script for a code judge is a mistake in the test", () => {
    expect(() => testUnit(NoBannedWordsJudge, { model: replyWith("PASS") })).toThrow(
      /no-banned-words-judge injects no JudgeModel \(it is decided by code\) — it calls no model; leave out model/u,
    );
  });

  it("the same assembly rules: a code judge with a model is refused", () => {
    expect(() => testUnit(NamedModelJudge)).toThrow(/^\[judge\.model-on-code-judge\]/u);
  });

  it("a model reached through a service is refused, naming the judge and the call", async () => {
    const run = testUnit(SecondOpinionJudge);

    const { output } = await run({
      variant: PlainTextDto,
      output: { text: "x" },
      task: "?",
      attempt: 0,
    });

    const reasons = output.passed ? [] : output.reason.split(" | ");
    expect(reasons).toEqual(
      ["invoke", "decide", "model"].map(
        (member) =>
          `[judge.model-on-code-judge] judge "second-opinion-judge" is decided by code and has no model — judgeModel.${member} is not available`,
      ),
    );
  });
});
