/**
 * #396 PR 1 — `@agboss/core/eval`: `@EvalSuite` and the builders of its cases and checks, typed by the
 * suite's start and each tool's input, and its assembly on the application it runs on —
 * `[name.kind-suffix]`, `[eval.unknown-start]`, `[eval.duplicate-case]`, `[eval.judge-wrong-output]`,
 * then the cases' values (`eval.case-invalid`). Nothing runs: no runner yet.
 */
import { describe, expect, it } from "vitest";
import {
  DecidedBy,
  GraphRuleError,
  Judge,
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
} from "../../src/index.js";
import { EvalCaseInvalidError } from "../../src/errors.js";
import { listOf } from "../../src/flow/dto-wrappers.js";
import {
  CheckStatus,
  EvalCascade,
  EvalSuite,
  evalCase,
  pastTurn,
  toolCall,
  toolInvariant,
  turn,
} from "../../src/eval/index.js";
import { checkEvalSuite } from "../../src/eval/suite/check-suite.js";
import { evalSuiteOf } from "../../src/eval/suite/eval-suite.decorator.js";
import {
  RefundCardOutputDto,
  RefundCardTool,
  RefundWorkflowFinish,
  RefundWorkflowStart,
  SlackRefundsApplication,
} from "../flow/fixtures/refunds.fixture.js";
import {
  BedRequestWorkflowStart,
  BedsDto,
  BedsWorkflowFinish,
  ClinicApplication,
  FreeBedsTool,
} from "../flow/fixtures/clinic.fixture.js";

/** A code judge of the refunds' finish: the refund is reported. */
@Judge({ name: "refunded-judge", output: RefundCardOutputDto })
class RefundedJudge implements JudgeHandler<RefundCardOutputDto> {
  judge({ output }: { readonly output: RefundCardOutputDto }): Promise<JudgeVerdict> {
    return Promise.resolve(
      output.status.startsWith("refunded")
        ? JudgeVerdict.passed()
        : JudgeVerdict.failed("no refund reported"),
    );
  }
}

/** A model judge of the clinic's finish: no reply of the refunds desk. */
@Judge({ name: "beds-judge", model: "local/judge", output: BedsDto, deps: [JudgeModel] })
class BedsJudge implements JudgeHandler<BedsDto> {
  judge(): Promise<JudgeVerdict> {
    return Promise.resolve(JudgeVerdict.passed());
  }
}

/** A judge of a list: never a finish's output. */
@Judge({ name: "refund-list-judge", output: listOf(RefundCardOutputDto) })
class RefundListJudge implements JudgeHandler<readonly RefundCardOutputDto[]> {
  judge(): Promise<JudgeVerdict> {
    return Promise.resolve(JudgeVerdict.passed());
  }
}

@EvalSuite({
  name: "refunds-eval-suite",
  description: "Refunds: the card refunded once, never over $100",
  start: RefundWorkflowStart,
  judges: [RefundedJudge],
  cascade: EvalCascade.StopAtFirstFailure,
  cases: [
    evalCase({
      name: "refund-within-policy",
      tenant: { tenantId: "eval-acme" },
      turns: [turn({ text: "Refund order 7, it arrived broken" })],
      tools: {
        required: [toolCall(RefundCardTool, { orderId: "7" })],
        invariants: [toolInvariant(RefundCardTool, (input) => input.amountCents <= 10_000)],
      },
    }),
    evalCase({
      name: "refund-after-history",
      history: [
        pastTurn({
          start: RefundWorkflowStart,
          input: { text: "Refund order 6" },
          finish: RefundWorkflowFinish,
          output: { status: "refunded 6" },
        }),
      ],
      turns: [turn({ text: "And order 7?" })],
      tools: { required: [toolCall(RefundCardTool)] },
      judges: [RefundedJudge],
      variants: [turn({ text: "Order 7 too, please" })],
    }),
  ],
})
class RefundsEvalSuite {}

describe("#396: @EvalSuite records the suite as written", () => {
  it("its start, ordered checks, cascade and cases, frozen", () => {
    const meta = checkEvalSuite(SlackRefundsApplication, RefundsEvalSuite);

    expect(meta).toBe(evalSuiteOf(RefundsEvalSuite));
    expect(meta.start).toBe(RefundWorkflowStart);
    expect(meta.judges).toEqual([RefundedJudge]);
    expect(meta.cascade).toBe(EvalCascade.StopAtFirstFailure);
    expect(meta.cases.map((written) => written.name)).toEqual([
      "refund-within-policy",
      "refund-after-history",
    ]);
    expect(Object.isFrozen(meta)).toBe(true);
  });

  it("each case's tools, history and turns, as built", () => {
    const [first, second] = checkEvalSuite(SlackRefundsApplication, RefundsEvalSuite).cases;
    if (first === undefined || second === undefined) throw new Error("two cases expected");

    expect(first.tools?.required).toEqual([{ tool: RefundCardTool, input: { orderId: "7" } }]);
    const [invariant] = first.tools?.invariants ?? [];
    expect(invariant?.holds({ orderId: "7", amountCents: 20_000 })).toBe(false);
    expect(second.history).toEqual([
      {
        start: RefundWorkflowStart,
        input: { text: "Refund order 6" },
        finish: RefundWorkflowFinish,
        output: { status: "refunded 6" },
      },
    ]);
    expect(second.tools?.required).toEqual([{ tool: RefundCardTool }]);
    expect(Object.isFrozen(first.turns?.[0])).toBe(true);
  });

  it("the closed sets are enums", () => {
    expect(Object.values(EvalCascade)).toEqual(["stop-at-first-failure", "run-all"]);
    expect(Object.values(CheckStatus)).toEqual(["passed", "failed", "skipped"]);
  });

  it("a class without @EvalSuite is named", () => {
    class NotASuite {
      readonly isSuite = false;
    }

    expect(() => checkEvalSuite(SlackRefundsApplication, NotASuite)).toThrow(
      /checkEvalSuite: NotASuite is not an @EvalSuite/u,
    );
  });
});

describe("#396: cases are typed by the suite's start, each tool's input and the finish's output", () => {
  it("a wrong turn, tool argument, invariant or past turn does not compile", () => {
    // @ts-expect-error -- the start takes { text }
    turn({ text: 7 }).input satisfies { text: string };
    // @ts-expect-error -- refund-card-tool has no field `order`
    toolCall(RefundCardTool, { order: "7" });
    // @ts-expect-error -- amountCents is a number
    toolInvariant(RefundCardTool, (input) => input.amountCents === "1");
    pastTurn({
      start: RefundWorkflowStart,
      input: { text: "a" },
      finish: RefundWorkflowFinish,
      // @ts-expect-error -- refund-workflow-finish answers { status }
      output: { text: "b" },
    });

    expect(toolCall(FreeBedsTool, { ward: "3" })).toEqual({
      tool: FreeBedsTool,
      input: { ward: "3" },
    });
  });

  it("the suite checks every case's turns against its start; cascade is optional", () => {
    EvalSuite({
      name: "a-eval-suite",
      description: "a",
      start: RefundWorkflowStart,
      cases: [],
    });
    EvalSuite({
      name: "b-eval-suite",
      description: "b",
      start: RefundWorkflowStart,
      cascade: EvalCascade.RunAll,
      // @ts-expect-error -- the start takes { text }, not { message }
      cases: [evalCase({ name: "b", turns: [turn({ message: "hi" })] })],
    });

    @EvalSuite({ name: "c-eval-suite", start: RefundWorkflowStart, cases: [] })
    class DefaultCascade {}
    expect(evalSuiteOf(DefaultCascade)?.cascade).toBe(EvalCascade.StopAtFirstFailure);
    expect(evalSuiteOf(DefaultCascade)?.description).toBeUndefined();
  });

  it("a suite of an application with its own contexts requires them, as app.execute does", () => {
    EvalSuite({
      name: "c-eval-suite",
      description: "c",
      start: BedRequestWorkflowStart,
      cascade: EvalCascade.RunAll,
      // @ts-expect-error -- the clinic declares its tenant and execution contexts
      cases: [evalCase({ name: "c", turns: [turn({ text: "a bed" })] })],
    });

    expect(BedsWorkflowFinish).toBeTypeOf("function");
  });
});

/** Every rule code a suite breaks on an application. */
const codesOf = (application: new () => unknown, suite: new () => unknown): readonly string[] => {
  try {
    checkEvalSuite(application, suite);
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.map((found) => found.code);
  }
};

describe("#396: the suite's assembly rules, every violation at once", () => {
  it("[name.kind-suffix] on its name and its class, [eval.duplicate-case]", () => {
    @EvalSuite({
      name: "refunds-suite",
      description: "misnamed",
      start: RefundWorkflowStart,
      cascade: EvalCascade.RunAll,
      cases: [
        evalCase({ name: "twice", turns: [turn({ text: "a" })] }),
        evalCase({ name: "twice", turns: [turn({ text: "b" })] }),
      ],
    })
    class RefundsSuite {}

    expect(codesOf(SlackRefundsApplication, RefundsSuite)).toEqual([
      "name.kind-suffix",
      "name.kind-suffix",
      "eval.duplicate-case",
    ]);
    expect(() => checkEvalSuite(SlackRefundsApplication, RefundsSuite)).toThrow(
      /\[eval\.duplicate-case\] refunds-suite: two cases are named "twice"/u,
    );
  });

  it("[eval.unknown-start]: the start belongs to another application", () => {
    @EvalSuite({
      name: "beds-eval-suite",
      description: "the clinic's start on the refunds desk",
      start: BedRequestWorkflowStart,
      cascade: EvalCascade.RunAll,
      cases: [],
    })
    class BedsEvalSuite {}

    expect(() => checkEvalSuite(SlackRefundsApplication, BedsEvalSuite)).toThrow(
      /\[eval\.unknown-start\] beds-eval-suite: bed-request-workflow-start is not a start of SlackRefundsApplication — its starts: refund-workflow-start/u,
    );
  });

  it("[eval.judge-wrong-output]: a judge of no finish the start reaches, or of a list", () => {
    @EvalSuite({
      name: "judged-eval-suite",
      description: "judges of the wrong replies",
      start: RefundWorkflowStart,
      judges: [BedsJudge, RefundedJudge],
      cascade: EvalCascade.RunAll,
      cases: [
        evalCase({
          name: "listed",
          turns: [turn({ text: "a" })],
          judges: [RefundListJudge, BedsJudge],
        }),
      ],
    })
    class JudgedEvalSuite {}

    expect(codesOf(SlackRefundsApplication, JudgedEvalSuite)).toEqual([
      "eval.judge-wrong-output",
      "eval.judge-wrong-output",
    ]);
    expect(() => checkEvalSuite(SlackRefundsApplication, JudgedEvalSuite)).toThrow(
      /judged-eval-suite: beds-judge judges BedsDto, but the runs of refund-workflow-start end at finishes with RefundCardOutputDto — it judges none of them/u,
    );
  });

  it("a judge's own rules: not a @Judge, a code judge with a model", () => {
    class NotAJudge {
      readonly isJudge = false;
    }
    // @ts-expect-error -- a code judge takes no model
    @Judge({
      name: "x-judge",
      model: "m",
      output: RefundCardOutputDto,
    })
    class ModelledJudge implements JudgeHandler<RefundCardOutputDto> {
      judge(): Promise<JudgeVerdict> {
        return Promise.resolve(JudgeVerdict.passed());
      }
    }
    const suiteJudgedBy = (judge: new () => unknown) => {
      @EvalSuite({
        name: "plain-eval-suite",
        description: "p",
        start: RefundWorkflowStart,
        // @ts-expect-error -- a judge is a class that is a @Judge
        judges: [judge],
        cascade: EvalCascade.RunAll,
        cases: [],
      })
      class PlainEvalSuite {}
      return PlainEvalSuite;
    };

    expect(() => checkEvalSuite(SlackRefundsApplication, suiteJudgedBy(NotAJudge))).toThrow(
      /^\[judge\.not-a-judge\] @EvalSuite "plain-eval-suite": NotAJudge/u,
    );
    expect(() => checkEvalSuite(SlackRefundsApplication, suiteJudgedBy(ModelledJudge))).toThrow(
      /^\[judge\.model-on-code-judge\] @Judge ModelledJudge/u,
    );
  });
});

describe("#396: eval.case-invalid — the cases' values, every issue at once, no value printed", () => {
  it("tenant and execution against the application's contexts, turns against the start, history against its start and finish", () => {
    @EvalSuite({
      name: "clinic-eval-suite",
      description: "a bed for the clinician",
      start: BedRequestWorkflowStart,
      cascade: EvalCascade.RunAll,
      cases: [
        evalCase({
          name: "valid",
          tenant: { tenantId: "eval-clinic", units: [{ unitId: "u1", name: "Ward 3" }] },
          execution: { clinician: { clinicianId: "c-1" }, unitId: "u1" },
          turns: [turn({ text: "a bed in ward 3" })],
          tools: { required: [toolCall(FreeBedsTool, { ward: "3" })] },
        }),
        // @ts-expect-error -- units are a list of units, the clinician is required, the start takes { text: string }
        evalCase({
          name: "broken",
          tenant: { tenantId: "eval-clinic", units: "u1" },
          execution: { unitId: "u1" },
          history: [
            pastTurn({
              start: BedRequestWorkflowStart,
              input: { text: "before" },
              finish: BedsWorkflowFinish,
              // @ts-expect-error -- the finish answers BedsDto
              output: { beds: 2 },
            }),
            pastTurn({
              start: BedsWorkflowFinish,
              // @ts-expect-error -- a past turn starts at a start
              input: { text: "x" },
              finish: BedRequestWorkflowStart,
              // @ts-expect-error -- and ends at a finish
              output: { text: "y" },
            }),
          ],
          turns: [turn({ text: 3 })],
        }),
        evalCase({
          name: "silent",
          tenant: { units: [] },
          execution: { clinician: { clinicianId: "c-2" }, unitId: "u2" },
          turns: [],
        }),
      ],
    })
    class ClinicEvalSuite {}

    const failure = (() => {
      try {
        checkEvalSuite(ClinicApplication, ClinicEvalSuite);
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    if (!(failure instanceof EvalCaseInvalidError)) throw new Error("expected eval.case-invalid");
    const invalid = failure;
    expect(invalid.code).toBe("eval.case-invalid");
    expect(invalid.suite).toBe("clinic-eval-suite");
    expect(invalid.issues.map(({ case: name, path }) => `${name} ${path}`)).toEqual([
      "broken tenant.units",
      "broken execution.clinician",
      "broken history[0].output.text",
      "broken history[1].start",
      "broken history[1].finish",
      "broken turns[0].text",
      "silent turns",
    ]);
    expect(invalid.message).not.toContain("u1");
    expect(invalid.message).toContain('case "silent": turns — a case runs at least one turn');
  });
});
