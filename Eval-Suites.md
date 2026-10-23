# Eval suites — `@EvalSuite` (`agboss/eval`)

An eval suite declares what a run on a live model must do, case by case (#396). The entry
`agboss/eval` holds the decorator and the builders of its cases and checks only — nothing runs at
import. A suite is assembled on its application before anything runs — by `agboss check` (Loop 0) and
by its runner, `agboss eval run` ([below](#running-a-suite-agboss-eval-run), #396 PR 2).

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

## Running a suite: `agboss eval run`

```bash
agboss eval run --suite refunds-eval-suite --runs 3 --env eval --report .artifacts/eval/main.json
```

- **Where suites are found**: every `eval-suites/*.eval-suite.ts` under the folder of the
  application file (any depth; `node_modules` and dot folders skipped), each module's exported
  `@EvalSuite` classes whose `start` is one of the application's starts. `--suite` names one by its
  full name; with a single suite it may be left out. Several and none named, or a name none has →
  `eval.unknown-suite`, exit 2, the suites listed.
- **The application** is built as `createApp` builds it, on the `--env` environment (default `dev`):
  its services, its model providers, its stores and budgets. The suite is assembled first — its rules
  (`graph.rules`, exit 3), then its cases' values (`eval.case-invalid`, exit 3) — before any case runs.
- **Each case runs `--runs` times** (k, default 1), one run after the other, each on a thread of its
  own: the case's `history` is written into the thread (each past turn a finished turn of the
  workflow — `start <name>: <input>` / `finish <name>: <output>` — no model call), its `turns` run in
  order through `app.execute` with the case's `tenant` / `execution` (validated as there), then the
  checks judge the last turn, in order, under the suite's cascade. A turn that fails, or an earlier
  one that pauses, ends the run with its `error: { code, message }` and no checks.
- **`checkTrajectory()`** reads the last turn's `result.toolCalls` ([Testing](Testing)): a `required`
  tool needs a call the tool ran (`Succeeded`, `Failed` or `TimedOut`) whose input matches the
  partial; a `forbidden` one fails on any call, even one that never ran; an invariant must hold on
  every call with checked arguments (not `InvalidArguments`). Every broken expectation is named in
  the reason: `get-order-tool not called with {"orderId":"7"} (required; 0 call(s)); delete-order-tool
  called (forbidden)`.
- **A judge** (`judgedBy(Judge)`, the suite's or the case's) is created by the application's container
  and runs in the frame of the case's last execution: its services, an injected `ExecutionContext`
  (that execution's `executionId` and thread), the project's `TenantContext` / execution fields with
  the case's values. It gets the finish's output as its DTO (`variant` = the finish's output class),
  `task` (the last turn's start line), `attempt: 0` and the last turn's `toolCalls`. A run that ended
  at a finish the judge does not judge — or at none (a pause) — fails that check
  (`the run ended at hand-over-workflow-finish, whose output answer-grounded-judge does not judge`).
  A model judge an agent also lists uses that binding; one only a suite lists is bound through the
  application's models; its calls are counted in the application's budgets and in the check's
  `spentUsd`. A judge that throws fails its check with the error's message.
- **Pass, pass@k, pass^k** (S2 Q6): a run passes when every check that ran passed — a skipped check
  fails the run. Per case, over its k runs: **pass@k** = at least one passed, **pass^k** = every one
  passed (n = k). A case with pass@k and not pass^k is **unstable** — a candidate for deterministic
  code ([above](#the-cascade-cheapest-check-first)).

What it prints:

```
refunds-eval-suite · desk-workflow 1.0.0 · config 7c1e09 · 3 cases × 3 runs · env eval
case                             pass@3  pass^3  runs  first failure
refund-within-policy             yes     yes     ✓✓✓
prohibition-survives-compaction  yes     no      ✓✗✓   run 2: trajectory: issue-store-credit-tool called (forbidden)   unstable
fresh-price-beats-memory         yes     yes     ✓✓✓
pass@3 3/3 · pass^3 2/3 · unstable 1 · judge calls 8 (1 skipped by the cascade) · spent $0.3120
report → .artifacts/eval/main.json
```

The exit code says whether the suite ran (0), never how well — unless it is compared with a
baseline and `--fail-on-regression` is given ([below](#against-a-baseline-baseline-runjson)).
`--profile <name>` runs the suite on `profiles/<workflow>/<name>.yaml`. The history a case writes is
kept `ExecutionRecordStatus.Written` (#396 S6): turns of their thread, which its memory reads, never
runs `agboss eval score` scores or `agboss golden add` saves.

### The run artifact

`--report <run.json>` writes it (folders created); `--json` carries the same object as the envelope's
`result` (`command: "eval"`, the file in `created`). It is also the reference a later run is read
against, so it says what it is and the version of its shape (#396 S3):

| Field | What it holds |
| --- | --- |
| `kind` | always `"agboss.eval-run"` |
| `schemaVersion` | `1`: a reader refuses a version it does not know |
| `suite`, `start`, `cascade`, `runs` | the suite's name and start, its cascade, k |
| `application`, `workflow` | `{ name, version }` of each |
| `configHash` | the workflow's fingerprint (`agboss describe --json`): what the runs ran on |
| `environment` | the environment's name |
| `startedAt`, `endedAt` | ISO 8601, on the application's `Clock` |
| `cases[]` | `name`, `caseHash` (the case as written, its tools' expectations, judges, the suite's checks and cascade — a changed case is not compared), `passed` (runs that passed), `runs`, `passAtK`, `passHatK`, `isUnstable`, `runResults[]` |
| `cases[].runResults[]` | `run` (1…k), `threadId`, `executionId` and `finish` of the last turn, `passed`, `checks[]`, `error?`, `spentUsd` |
| `…checks[]` | `check` (`trajectory` or the judge's name), `status` (`CheckStatus`: `passed`, `failed`, `skipped`), `reason?`, `skippedBy?` (the failed check that skipped it), `metrics?` (a judge's), `spentUsd?` (a model judge's) |
| `summary` | `cases`, `passAtK`, `passHatK`, `unstable` (counts of cases), `judgeCalls` (judge checks that ran), `skippedByCascade` |
| `spend` | `{ totalUsd }`: every turn's execution and every judge's model calls |
| `baseline?` | the run against `--baseline` (`EvalRunComparison`, below) |

The artifact's types are public in `agboss/eval` (#396 S6): `EvalRunReport`, `EvalCaseReport`,
`EvalRunResult`, `EvalCheckResult`, `EvalRunError`, `EvalRunSummary`, `EvalRunComponent`,
`EvalRunSpend`, with `EVAL_RUN_KIND` and `EVAL_RUN_SCHEMA_VERSION`.

### The HTML report: `--html` and `agboss eval show` (#397)

```bash
agboss eval run --suite refunds-eval-suite --runs 3 --report .artifacts/eval/main.json --html .artifacts/eval/main.html
agboss eval show .artifacts/eval/main.json --html .artifacts/eval/main.html
```

`--html <file>` on `eval run` writes the run as one self-contained HTML page next to (or instead of)
the artifact; `agboss eval show <run.json>` reads a saved artifact — runs nothing, loads no
application, needs no key — prints the same table as `eval run` and, with `--html <file>`, writes the
same page. So CI renders a pull request's report from the artifact it already has, without a second
model bill. Both print `html → <file> (<size>, self-contained)`; under `--json` the file is in
`created` (`eval show`'s `result` is the artifact as read).

The page is one file: its CSS and its one script inline, no fonts, images or requests — its
`Content-Security-Policy` allows nothing but its own style and script (by hash), so it opens the
same from `file://`, a CI artifact or a PR attachment. It reads in light and dark
(`prefers-color-scheme`), at phone width, and without its script; it is semantic HTML (landmarks,
headings, tables, `details`), every control reachable by keyboard. What it shows:

| Section | From the artifact |
| --- | --- |
| Header | the suite, the application and workflow with their versions, `configHash`, the start, the environment, k, the cascade, when it started and ended, how long it took |
| Summary | pass@k and pass^k (cases and share), cases, attempts (cases × k), unstable cases, judge calls and those the cascade skipped, the total spend |
| Unstable cases | only when there are some: each case with pass@k and not pass^k, its passed / k, linked to its row — candidates for deterministic code, not a longer prompt |
| Cases | one per case: pass@k / pass^k, an attempt dot per run 1…k — passed, failed (a check failed), error (a turn failed or paused), limit (its error is a `limit.*`) — each a link that opens that run: its `executionId`, thread, finish, spend, error, and every check with its status, reason, the check that skipped it, a judge's metrics and spend. A filter shows all cases, the failed ones (not pass^k) or the unstable ones |

It shows only what the artifact holds — check reasons and errors as the run wrote them, already
masked by the application's PII policies; the page adds nothing from the project and escapes every
value. The page is bounded: above 16 MB it is not written — `eval.report-too-large`, exit 2 (the
artifact of `eval run` is written first and kept). `eval show` refuses a file that is not a run
artifact this version reads — `eval.run-not-found` (no such file) or `eval.run-invalid` (not JSON,
another `kind`, an unknown `schemaVersion`, a field missing), exit 2.

Not yet on the page: the comparison with a baseline (the artifact's `baseline`, #396 PR 3 — its
section comes later in #397), a run's step-by-step timeline (#397 PR 2), labels and failure tags
(#397 PR 4).

## Against a baseline: `--baseline <run.json>`

```bash
agboss eval run --suite refunds-eval-suite --runs 3 --env eval --baseline main.json --fail-on-regression
```

A baseline is a run artifact — the `--report` of a run of `main` (S2 C1: there is no separate
`--save-baseline`). It is read before anything runs, by the same reader as `eval show` (one reader, #397 S4): no
such file is `eval.run-not-found`; another `kind`, another `schemaVersion`, a missing field or a run
of another suite is `eval.run-invalid` (exit 2); `--fail-on-regression` without `--baseline` is a
usage error. Each case is compared by name (`CaseComparison`, `agboss/eval`):

| Verdict | When |
| --- | --- |
| `Regressed` | pass^k on the baseline, not now — the only verdict `--fail-on-regression` fails on |
| `Improved` | no pass@k on the baseline (every run failed), pass@k now |
| `Unchanged` | neither |
| `FlakyOnBaseline` | pass@k without pass^k on the baseline: it flapped there too — quarantined, never a failure |
| `New` / `Removed` | only in this run / only in the baseline |
| `Changed` | another `caseHash`: the case, its tools' expectations, its judges, the suite's checks or cascade changed — not compared |

```
case                             baseline  candidate  verdict
refund-within-policy             3/3       1/3        regressed
prohibition-survives-compaction  2/3       1/3        flaky-on-baseline (quarantined)
fresh-price-beats-memory         3/3       3/3        unchanged
1 regressed · 1 unchanged · 1 quarantined
error: 1 case regressed against main.json: refund-within-policy (eval.regressed, exit 5)
```

With `--fail-on-regression` a regression exits **5** (`quality`, `eval.regressed`: "the agent got
worse", told apart from 3 "the project does not load"); without it the run exits 0 and shows the
table. The artifact (and `--json`'s `result`) gains `baseline` — `EvalRunComparison`: `file`, the
baseline's `configHash`, `startedAt` and `runs`, `cases` (each `EvalCaseComparison`: `name`,
`comparison`, `baseline` / `candidate` passes `{ passed, runs }`) and `regressed` (the names).

## Calibrating a judge: `agboss eval calibrate`

```bash
agboss eval calibrate --report .artifacts/eval/main.json                    # labels: eval/labels/<suite>.jsonl
agboss eval calibrate --report .artifacts/eval/main.json --labels labels/refunds.jsonl
```

A model judge in the cascade is only as good as its agreement with people. People label the judged
runs of an artifact — one JSON line each (`EvalLabel`, `agboss/eval`), in `eval/labels/<suite>.jsonl`
by default, a file that grows over many runs:

```json
{"runId":"refund-within-policy#2","executionId":"0f3c…","judge":"answer-grounded-judge","labeler":"anna","passed":false,"score":2,"failureTags":["invents-fee"],"note":"invents a fee"}
```

| Field | |
| --- | --- |
| `runId` | the case and its run as the artifact numbers them, `<case>#<run>` |
| `executionId` | the run's last execution — the one its judges judged (`executionId` of the run in the artifact) |
| `judge` | the judge's `name` |
| `labeler` | who labelled it |
| `passed` | the person's verdict — what κ reads |
| `score?` | 1–4, how good the answer is: only for the scores view |
| `failureTags` | why it failed, in the labeler's words (`[]` for none) |
| `note?` | free text |

`agboss eval calibrate` reads the artifact and the labels — it loads no application and calls no
model — and prints, per judge that has labels:

```
refunds-eval-suite against eval/labels/refunds-eval-suite.jsonl: 120 labels, 118 matched, 2 of other runs or unjudged
answer-grounded-judge  n=60  κ(judge, anna)=0.71  κ(judge, ben)=0.64  κ(anna, ben)=0.78
  anna          anna passed  anna failed
  judge passed  38           7
  judge failed  2            13
  …
  9 disagreements: judge passed / labeler failed 7, judge failed / labeler passed 2
    refund-within-policy#2 anna: judge passed, labeler failed [invents-fee] — invents a fee
  length: 9 disagreements, 51 agreements — mean 940.00 on disagreements, 410.00 on agreements
  grounded: 9 disagreements, 51 agreements — disagreed/agreed by value: false 6/3, true 3/48
  scores 1–4: judge passed 6·3·9·27, judge failed 10·4·1·0
```

- **κ** is Cohen's, pairwise (#396 S2 Q8): the judge with each labeler, then every two labelers on the
  runs both labelled — how far they agree beyond what their own pass rates give by chance; `κ=—`
  when a rater gave one verdict only. The labelers' κ is the ceiling: a judge cannot be held to more
  agreement than people have with each other.
- **The confusion matrix** per labeler, and every **disagreement** (the run, the labeler, the judge's
  metrics, the tags and the note).
- **The rubric:** each key of the judge's `metrics` (`JudgeVerdict.passed({ metrics })`) over the
  disagreements and the agreements — a text or flag metric by value, a numeric one by its mean on
  each side — so the measure that goes with the judge being wrong stands out (above: long answers).
- **Scores:** with a `score` in any label, how the scores spread over the runs the judge passed and
  failed.

Labels of executions the artifact does not have, or of a judge that gave no verdict there (skipped
by the cascade), are counted as unmatched — never an error. A line that is not a label, a second
label of one run by one labeler for one judge, or a `runId` that is not its execution's run in this
artifact is `eval.labels-invalid` (exit 2, the line named); no file is `eval.labels-not-found`.
`--json` carries the calibration — `EvalCalibration` (`suite`, `labels`, `matched`, `unmatched`,
`judges`: each `EvalJudgeCalibration` with `n`, `labelers`, `agreements` (`EvalRaterAgreement`:
`raters`, `n`, `observed`, `kappa?`), `confusion`, `disagreements`, `metrics`, `scores?`), all public
types in `agboss/eval`.
