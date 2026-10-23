# Eval suites — `@EvalSuite` (`agboss/eval`)

An eval suite declares what a run on a live model must do, case by case (#396). The entry
`agboss/eval` holds the decorator and the builders of its cases and checks only — nothing runs at
import. A suite is assembled on its application before anything runs; the runner is the CLI's and
comes with #396 PR 2.

- One class per file: `eval-suites/<name>.eval-suite.ts`, its `name` kebab-case ending with
  `-eval-suite`, its class with `EvalSuite` (`[name.kind-suffix]`).
- `start`: the `@WorkflowStart` every turn of every case goes through — a start of the application
  (`[eval.unknown-start]`).
- `checks`: what decides whether a run passed, **in the order listed** — `checkTrajectory()` (each
  case's `tools`, deterministic, $0) and `judgedBy(Judge)` (a `@Judge` on the finish's output).
- `cascade`: required — `EvalCascade.StopAtFirstFailure` (a failed check skips the rest:
  `CheckStatus.Skipped`, and a skipped check fails the run) or `EvalCascade.RunAll`.
- `cases`: each one a thread of its own (below), each `name` unique in the suite
  (`[eval.duplicate-case]` — a case name keys reports and baselines).

## The application under eval

<!-- snippet-context
import { Application, DecidedBy, EmptyEnvironment, Injectable, Judge, JudgeModel, JudgeVerdict, Tool, Workflow, WorkflowFinish, WorkflowStart, Agent, start, type JudgeHandler, type JudgeInput, type ToolHandler } from "agboss";
import { Integer, Text, WorkflowStartTextDto } from "agboss/dto";
-->

```ts file=src/refunds/refunds.ts
export class RefundRequestDto {
  @Text({ prompt: "the order id" })
  orderId!: string;

  @Integer({ prompt: "the amount in cents", min: 1 })
  amountCents!: number;
}

export class RefundDoneDto {
  @Text({ prompt: "what was refunded" })
  status!: string;
}

@Injectable()
export class RefundLedger {
  record(orderId: string): Promise<string> {
    return Promise.resolve(`refunded ${orderId}`);
  }
}

@Tool({
  name: "refund-tool",
  description: "Refunds an order",
  input: RefundRequestDto,
  output: RefundDoneDto,
  deps: [RefundLedger],
})
export class RefundTool implements ToolHandler<RefundRequestDto, RefundDoneDto> {
  constructor(private readonly refundLedger: RefundLedger) {}

  async run({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    return { status: await this.refundLedger.record(orderId) };
  }
}

@Tool({
  name: "delete-order-tool",
  description: "Deletes an order",
  input: RefundRequestDto,
  output: RefundDoneDto,
})
export class DeleteOrderTool implements ToolHandler<RefundRequestDto, RefundDoneDto> {
  run({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    return Promise.resolve({ status: `deleted ${orderId}` });
  }
}

@Agent({
  name: "refund-agent",
  description: "Refunds orders",
  prompt: "Refund what is asked, within policy.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: RefundDoneDto,
  tools: [RefundTool, DeleteOrderTool],
})
export class RefundAgent {}

@WorkflowStart({ name: "refund-workflow-start", description: "A refund request", input: WorkflowStartTextDto })
export class RefundWorkflowStart {}

@WorkflowFinish({ name: "refund-workflow-finish", description: "The refund", output: RefundDoneDto })
export class RefundWorkflowFinish {}

@Workflow({
  name: "refunds-workflow",
  version: "1.0.0",
  flow: [
    start(RefundWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(RefundAgent)
      .returns(RefundDoneDto)
      .toFinish(RefundWorkflowFinish),
  ],
  providers: [RefundLedger],
})
export class RefundsWorkflow {}

@Application({
  name: "refunds-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RefundsWorkflow],
})
export class RefundsApplication {}

// a code judge: deterministic, $0
@Judge({ name: "refund-reported-judge", decidedBy: DecidedBy.Code, reply: RefundDoneDto })
export class RefundReportedJudge implements JudgeHandler<RefundDoneDto> {
  judge({ reply }: JudgeInput<RefundDoneDto>): Promise<JudgeVerdict> {
    return Promise.resolve(
      reply.status.startsWith("refunded")
        ? JudgeVerdict.passed()
        : JudgeVerdict.failed({ reason: "the answer does not report a refund" }),
    );
  }
}

// a model judge: paid
@Judge({ name: "polite-refund-judge", model: "moonshotai/kimi-k2.6", reply: RefundDoneDto, deps: [JudgeModel] })
export class PoliteRefundJudge implements JudgeHandler<RefundDoneDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply }: JudgeInput<RefundDoneDto>): Promise<JudgeVerdict> {
    const answer = await this.judgeModel.invoke(`Is "${reply.status}" polite? Answer yes or no.`);
    return /^\s*yes/iu.test(answer)
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed({ reason: "be polite" });
  }
}
```

## A suite

<!-- snippet-context
import { DeleteOrderTool, PoliteRefundJudge, RefundReportedJudge, RefundTool, RefundWorkflowFinish, RefundWorkflowStart } from "../refunds.js";
-->

```ts file=src/refunds/eval-suites/refunds.eval-suite.ts
import {
  EvalCascade,
  EvalSuite,
  checkTrajectory,
  evalCase,
  judgedBy,
  pastTurn,
  toolCall,
  toolInvariant,
  turn,
} from "agboss/eval";

@EvalSuite({
  name: "refunds-eval-suite",
  description: "Refunds: looked up once, never deleted, never over $100",
  start: RefundWorkflowStart,
  checks: [
    checkTrajectory(), // 1. each case's `tools`: free
    judgedBy(RefundReportedJudge), // 2. a code judge: free
    judgedBy(PoliteRefundJudge), // 3. a model judge: paid, runs only on a run the two above passed
  ],
  cascade: EvalCascade.StopAtFirstFailure, // required: no implicit order
  cases: [
    evalCase({
      name: "refund-within-policy",
      tenant: { tenantId: "eval-acme" }, // validated like app.execute's
      turns: [turn({ text: "Refund order 7, it arrived broken" })],
      tools: {
        required: [toolCall(RefundTool, { orderId: "7" })], // some call has these arguments
        forbidden: [DeleteOrderTool],
        invariants: [toolInvariant(RefundTool, (input) => input.amountCents <= 10_000)],
      },
    }),
    evalCase({
      name: "refund-after-a-question",
      history: [
        // written into the thread, not run: what memory and its compaction read
        pastTurn(RefundWorkflowStart, { text: "Was order 8 refunded?" }, RefundWorkflowFinish, {
          status: "refunded 8",
        }),
      ],
      turns: [turn({ text: "Now order 9, please" })],
      tools: { required: [toolCall(RefundTool, { orderId: "9" })] },
      judges: [judgedBy(RefundReportedJudge)], // after the suite's checks, for this case only
      variants: [turn({ text: "Please refund order 9 as well" })], // rewordings: the same tools
    }),
  ],
})
export class RefundsEvalSuite {}
```

## A case

- **`turns`** run in order on the case's thread through the suite's start; the checks judge the
  last. At least one. Each turn is the start's input (`turn({ text })`), typed by the generated
  `.agboss/types.d.ts`.
- **`history`** — past turns written into the thread before the first turn, not run (no model cost):
  `pastTurn(Start, input, Finish, output)`, the input typed by that start, the output by that finish.
- **`tenant` / `execution`** — the execution's context values, typed and required as at
  `app.execute` (an application that declares its own `TenantContext` subclass needs its fields).
- **`tools`** — what `checkTrajectory()` checks: `required` (`toolCall(Tool, partial?)` — a deep
  partial of the tool's input; without it any call), `forbidden` (tool classes), `invariants`
  (`toolInvariant(Tool, (input) => boolean)` — every call of the tool, its input typed by the tool's
  DTO).
- **`judges`** — judges of this case only, after the suite's checks.
- **`variants`** — rewordings of the last turn, for metamorphic runs.

## The cascade: cheapest check first

The order is a declaration, never a convention: free trajectory invariants first, then code judges
(`@Judge({ decidedBy: DecidedBy.Code })`, [Judges](Judges-And-Quality-Gates)), then model judges.
Under `EvalCascade.StopAtFirstFailure` a paid judge runs only on a run the free checks passed.

When a case passes at least once in k runs but not every time (pass@k high, pass^k low), do not grow
the prompt: move the check into deterministic code — a tool interceptor, a code guardrail
(`decidedBy: DecidedBy.Code`, [Guards](Guards)), `DecidedBy.Code` on a `@Router` or an `@Arbiter`, or
an `@Action`.

## The rules

A suite is assembled on its application before anything runs — every rule violation at once, one
`GraphRuleError`:

| Code                       | Means                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `[name.kind-suffix]`       | the `name` does not end with `-eval-suite`, or the class with `EvalSuite`          |
| `[eval.unknown-start]`     | `start` is not a start of the application (its starts listed)                      |
| `[eval.duplicate-case]`    | two cases share a `name`                                                           |
| `[eval.judge-wrong-reply]` | a judge judges no finish output the start reaches, or judges a list               |

An eval judge judges the output of the finish the run ended at, so its `reply` is a finish's
`output` the start reaches — one value; `oneOf(…)` for several finishes. A judge's own rules apply
too (`[judge.not-a-judge]`, `[judge.no-model]`, `[judge.model-on-code-judge]`).

Then the cases' values: `EvalCaseInvalidError` (`eval.case-invalid`, from `agboss`) lists every
issue at once — `case "x": tenant.plan — <reason>`, `turns[0].text`, `history[1].output.status`,
`variants[0]`, `turns` (no turn) — the field named, never the value.
