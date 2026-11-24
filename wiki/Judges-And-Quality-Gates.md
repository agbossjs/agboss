# Judges and Quality Gates

A judge checks an agent's answer before it leaves the agent. A rejected answer goes back to the
agent with the judge's `reason` — inside the agent's own loop, so the checkpoint history does not
fill up with failed attempts — and once `maxRetries` retries are spent the run throws
`QualityGateError` (`code: "step.agent.quality-gate"`, `rejections: [{ judge, reason }]`).

## A judge

A `@Judge({ output, deps })` class has a `judge(input)` method — sync or async, no `implements`
needed; the container creates it with its `deps`. A judge that injects `JudgeModel` (`deps: [JudgeModel]`)
calls its **own** model through the model gateway, so its spend is in the run's cost report
(`judge:<name>`); `model` names it, and when it is left out the judge asks its provider's default
role (`modelProvider`, else its workflow's, else its application's — [Model providers](Model-providers)).
A judge that injects no `JudgeModel` is decided by code alone
([A code judge](#a-code-judge-no-model)); it names no `model` (`[judge.model-on-code-judge]`).

A judge sees the agent's answer **as its DTO** (#262 S115). `output` declares what it judges, in
every shape an agent's `output` has:

| `output`              | The agent it judges                    | `input.output` is                                   | `input.variant` is                    |
| --------------------- | -------------------------------------- | --------------------------------------------------- | ------------------------------------- |
| `JobReportDto`        | `output: JobReportDto`                 | the validated `JobReportDto`                        | `JobReportDto`                        |
| `oneOf(A, B)`         | `output: oneOf(A, B)` (or `A`, or `B`) | the variant's value, `A` or `B`                     | `A` or `B` — the class it answered as |
| `listOf(JobDto)`      | `output: listOf(JobDto)`               | the items, `readonly JobDto[]`                      | `JobDto`                              |
| `listOf(oneOf(A, B))` | `output: listOf(oneOf(A, B))`          | each item `{ variant, value }`, `readonly VariantOf<A \| B>[]` | — (each item has its own)  |
| `PlainTextDto`        | a text agent (no `output`)             | `{ text }` — its reply                              | `PlainTextDto`                        |

`judge(input)` gets what it judges as data (`JudgeInput<Self>`: `variant`, `output`, `task` — the
agent's input message, `attempt` — retries so far) and nothing else (#280: no `JudgeContext`); each judge
gets its own copy of the answer, so none changes what the step gives. Its model comes through the
constructor — `deps: [JudgeModel]`, each call going to the model of the judge whose `judge()` runs
(used anywhere else it throws `[judge.model-outside-judge]`); the execution, like in any component,
through `deps: [ExecutionContext]` (the judged agent is `step.component`).

`judge(input)` returns its verdict directly — a code judge needs no `Promise.resolve` — or a promise.
`JudgeInput<T>` takes the judge class itself (`judge(input: JudgeInput<OneSentenceJudge>)`: its `output` is
read from the generated `AGBossTypes.JudgeOutputs` table, so the class does not repeat it; before
`agboss check` it is `MissingGeneratedTypes`) or the output type directly (`JudgeInput<PlainTextDto>`,
for a library without generated types). `WorkflowFinishTextDto` extends `PlainTextDto`, so one
`@Judge({ output: PlainTextDto })` judges a text agent's answer, a text `@WorkflowFinish` and an eval
suite's `judges`.

A verdict is built only with **`JudgeVerdict.passed({ metrics? })`** or
**`JudgeVerdict.failed(reason, { metrics? })`** — a plain object does not compile (one way). A
failed verdict's `reason` is what the agent reads before its retry.

```ts file=judges/correctness.judge.ts
import {
  Judge,
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
} from "@agboss/core";
import { PlainTextDto } from "@agboss/core/dto";

@Judge({
  name: "correctness-judge",
  model: "moonshotai/kimi-k2.6",
  output: PlainTextDto, // a text agent's reply: { text }
  deps: [JudgeModel],
})
export class CorrectnessJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ output, task, attempt }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const verdict = await this.judgeModel.invoke(
      `Task: ${task}\nReply: ${output.text}\nAnswer PASS if the reply is correct and complete, else explain what is wrong.`,
    );
    return verdict.trim().startsWith("PASS")
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed(verdict, { metrics: { attempt } });
  }
}
```

On a **decision model** the judge asks typed questions instead — `judgeModel.decide({ state, questions })`
with `Decision.boolean` (yes/no → P(yes)), `Decision.choice` (an option, probabilities, confidence) and
`Decision.score` (levels, lowest first → the level's index); the answers are typed by the questions:

```ts file=judges/grounded.judge.ts
import {
  Decision,
  Judge,
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
} from "@agboss/core";
import { PlainTextDto } from "@agboss/core/dto";

@Judge({
  name: "grounded-judge",
  model: "openai/gpt-6-luna-decisions",
  output: PlainTextDto,
  deps: [JudgeModel],
})
export class GroundedJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ output, task }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const a = await this.judgeModel.decide({
      state: { task, reply: output.text },
      questions: {
        grounded: Decision.boolean("Every fact in the reply follows from the task"),
        quality: Decision.score("Overall usefulness", ["useless", "partial", "complete"]),
      },
    });
    return a.grounded.probability > 0.7 && a.quality.score >= 1
      ? JudgeVerdict.passed({ metrics: { quality: a.quality.score } })
      : JudgeVerdict.failed("Only state facts you can support, and answer the whole task.");
  }
}
```

`decide` on a chat model or `invoke` on a decision model throws `ModelKindError` (`model.wrong-kind`).

## A declarative judge: an empty class with a prompt

A model judge needs no code. An empty `@Judge` class with a `prompt` — a `.prompt.md` file next to it,
or `inline(…)` — is decided by its own model, which reads the criterion, the task and the answer and
answers one **structured verdict**, never a text marker:

```ts
@Judge({
  description: "The explanation is grounded in the order record",
  output: SupportAnswerDto,
  prompt: "./grounded-answer.prompt.md",
  model: "fast",
  threshold: 0.8,
})
export class GroundedAnswerJudge {}
```

- Without `threshold` the model answers `{ passed, reason }`; with it `{ score, reason }` (0 to 1), and the
  answer passes when `score >= threshold` — `threshold` is in `(0, 1]` (`[judge.bad-threshold]`), and only
  a judge with a `prompt` has one (`[judge.threshold-without-prompt]`). The score is kept in the verdict's
  `metrics`.
- A chat model answers one JSON object; a decision model (`openai/gpt-6-luna-decisions`) answers one yes/no
  question, its probability of yes the score. An answer that is no verdict fails the agent closed with
  `DecisionError.InvalidResponse` — its message names the judge, never what the model said.
- `prompt` is read at assembly like an agent's (a path starts with `./`, `../` or `/`; a list is joined in
  order); the file is looked up next to the declaring file. A `prompt` and a `judge(input)` method on one class
  (`[judge.declarative-with-judge]`), a `prompt` and `deps` (`[judge.declarative-with-deps]`) or a prompt that is
  none (`[judge.bad-prompt]`) fail assembly.
- `model` and `modelProvider` are as on any model judge: the role of its provider when left out.
- The execution's budgets are checked **before each model call** of a judge: once a judge's call spends them, the
  next judge makes none and the run stops with `BudgetExceededError`.
- In `testUnit` and in `testWith` a declarative judge nobody scripted **passes** (`replyWith` /
  `decideWith({ verdict: … })` script it); it is still asked, so `mockLlm(Judge).requests` shows what it read.

## A code judge: no model

A judge whose rule is code — a length, a format, a side effect a service can look up — needs no
model: a `@Judge` whose `deps` hold no `JudgeModel` decides by its `judge(input)` alone. No model call,
cost 0, nothing to script; its services and the execution come through `deps` like any component's.
`model` and `modelProvider` are for a judge that injects `JudgeModel` — on a code judge they do not
compile. One that names a `model` anyway (plain JS) fails assembly with
`[judge.model-on-code-judge]`; a `JudgeModel` reached through a service throws the same code when
called. It runs in an agent's quality gate beside model judges — list the free one first, every
judge runs — and in an eval suite's checks ([Eval suites](Eval-Suites)).

```ts file=judges/one-sentence.judge.ts
import { ExecutionContext, Judge, JudgeVerdict, type JudgeHandler, type JudgeInput } from "@agboss/core";
import { PlainTextDto } from "@agboss/core/dto";

@Judge({
  name: "one-sentence-judge",
  description: "The reply is one sentence", // no JudgeModel in deps: no model, no cost
  output: PlainTextDto,
  deps: [ExecutionContext],
})
export class OneSentenceJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly executionContext: ExecutionContext) {}

  judge({ output }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const sentences: number = output.text.split(/[.!?](\s|$)/u).filter((part) => part.trim() !== "").length;
    const tenant: string = this.executionContext.tenant.tenantId;
    return Promise.resolve(
      sentences <= 1
        ? JudgeVerdict.passed({ metrics: { sentences, tenant } })
        : JudgeVerdict.failed("answer in one sentence"),
    );
  }
}
```

In tests a code judge has no script — `mockLlm(OneSentenceJudge)` fails, naming why ("a code judge
calls no model — mockOf() the services its judge() uses"); `testUnit(OneSentenceJudge)` runs it with
no `model` (one is a `TestSetupError`) and no spend.

## A judge of a DTO answer

An agent with `output` answers a DTO; its judge declares that class and reads the fields — no
parsing, no text matching. A judge may need no model call at all (its model stays required):

```ts file=judges/answer-grounded.judge.ts
import {
  Injectable,
  Judge,
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
} from "@agboss/core";
import { List, Text } from "@agboss/core/dto";

export class JobDto {
  @Text({ prompt: "the job's title" })
  title!: string;

  @Text({ prompt: "where the job is posted" })
  url!: string;
}

export class JobReportDto {
  @List(JobDto, { prompt: "the jobs found" })
  jobs!: JobDto[];
}

@Injectable()
export class JobSearch {
  exists(url: string): Promise<boolean> {
    return Promise.resolve(url.startsWith("https://"));
  }
}

@Judge({
  name: "answer-grounded-judge",
  model: "typesafe/jev-1.13",
  output: JobReportDto,
  deps: [JudgeModel, JobSearch],
})
export class AnswerGroundedJudge implements JudgeHandler<JobReportDto> {
  constructor(
    private readonly judgeModel: JudgeModel,
    private readonly jobSearch: JobSearch,
  ) {}

  async judge({ output }: JudgeInput<JobReportDto>): Promise<JudgeVerdict> {
    const [first] = output.jobs;
    const found: boolean = first !== undefined && (await this.jobSearch.exists(first.url));
    return found
      ? JudgeVerdict.passed({ metrics: { jobs: output.jobs.length } })
      : JudgeVerdict.failed("the first job does not exist");
  }
}
```

### The variant of a `oneOf` output

`input.variant` is the class the answer validated as (#262 S125): the class of the answer tool the
agent used — never guessed from the answer's shape, never compared by name. For a
`oneOf(OfferDto, RefusalDto)` judge `JudgeInput<OfferDto | RefusalDto>` is a discriminated union —
`{ variant: typeof OfferDto; output: OfferDto; … } | { variant: typeof RefusalDto; output: RefusalDto; … }` —
and `isVariant(input, OfferDto)` narrows `output` to `OfferDto` (the other branch to `RefusalDto`).
`input.variant === OfferDto` is true at run time too, but TypeScript narrows an object only on a
literal discriminant, never on a class, so `isVariant` is the way to narrow:

<!-- snippet-context
import { Integer, Text } from "@agboss/core/dto";
export class OfferDto {
  @Integer({ prompt: "the salary offered" })
  salary!: number;
}
export class RefusalDto {
  @Text({ prompt: "why the candidate is refused" })
  why!: string;
}
-->

```ts
import { Judge, JudgeVerdict, type JudgeHandler, type JudgeInput } from "@agboss/core";
import { isVariant, oneOf } from "@agboss/core";

@Judge({ name: "fair-decision-judge", model: "typesafe/jev-1.13", output: oneOf(OfferDto, RefusalDto), deps: [JudgeModel] })
export class FairDecisionJudge implements JudgeHandler<OfferDto | RefusalDto> {
  judge(input: JudgeInput<OfferDto | RefusalDto>): Promise<JudgeVerdict> {
    if (isVariant(input, OfferDto)) {
      // the agent answered through answer-offer-dto: input.output is an OfferDto
      return Promise.resolve(
        input.output.salary > 0
          ? JudgeVerdict.passed({ metrics: { salary: input.output.salary } })
          : JudgeVerdict.failed("an offer pays something"),
      );
    }
    // input.variant is RefusalDto, input.output a RefusalDto
    return Promise.resolve(
      input.output.why.trim() === ""
        ? JudgeVerdict.failed("a refusal says why")
        : JudgeVerdict.passed(),
    );
  }
}
```

A judge of one class has `variant` as that class (a subclass the agent answered with, when its
`output` extends the judge's `output`), a text judge `PlainTextDto`, a `listOf(XDto)` judge the
list's one class. A `listOf(oneOf(A, B))` judge has no `variant` of its own: its `output` is
`readonly VariantOf<A | B>[]` — each item `{ variant, value }` (`VariantOf` from `@agboss/core/dto`), as
the answer's items are kept — narrowed by `isVariant(item, A)`:

<!-- snippet-context
import { Integer, Text } from "@agboss/core/dto";
export class OfferDto {
  @Integer({ prompt: "the salary offered" })
  salary!: number;
}
export class RefusalDto {
  @Text({ prompt: "why the candidate is refused" })
  why!: string;
}
-->

```ts
import { Judge, JudgeVerdict, type JudgeHandler, type JudgeInput } from "@agboss/core";
import { isVariant, listOf, oneOf, type VariantOf } from "@agboss/core";

type Decisions = readonly VariantOf<OfferDto | RefusalDto>[];

@Judge({
  name: "decisions-judge",
  model: "typesafe/jev-1.13",
  output: listOf(oneOf(OfferDto, RefusalDto)),
},
  deps: [JudgeModel],
)
export class DecisionsJudge implements JudgeHandler<Decisions> {
  judge({ output }: JudgeInput<Decisions>): Promise<JudgeVerdict> {
    const salaries: readonly number[] = output.flatMap((decision) =>
      isVariant(decision, OfferDto) ? [decision.value.salary] : [],
    );
    return Promise.resolve(
      salaries.length <= 1
        ? JudgeVerdict.passed({ metrics: { offers: salaries.length } })
        : JudgeVerdict.failed("make at most one offer"),
    );
  }
}
```

A list agent's judge declares the list and gets its items (`variant` is `JobDto`):

```ts
import { Judge, JudgeVerdict, type JudgeHandler, type JudgeInput } from "@agboss/core";
import { listOf } from "@agboss/core";
import { JobDto, JobSearch } from "./judges/answer-grounded.judge.js";

@Judge({ name: "jobs-judge", model: "typesafe/jev-1.13", output: listOf(JobDto), deps: [JobSearch, JudgeModel] })
export class JobsJudge implements JudgeHandler<readonly JobDto[]> {
  constructor(private readonly jobSearch: JobSearch) {}

  async judge({ output }: JudgeInput<readonly JobDto[]>): Promise<JudgeVerdict> {
    const found: readonly boolean[] = await Promise.all(
      output.map((job) => this.jobSearch.exists(job.url)),
    );
    return found.length > 0 && found.every(Boolean)
      ? JudgeVerdict.passed({ metrics: { jobs: output.length } })
      : JudgeVerdict.failed("every job must still be posted");
  }
}
```

## A judge that reads files (#899)

`JudgeInput.files` holds the files the agent's model read in the visit, in the views it got them (an
original as the file, a transcription as a `text/plain` file of its masked text); `[]` for an agent without
`files`. `judgeModel.invoke` and `judgeModel.decide` carry them as parts of their input (a decision model:
png, jpeg, webp and text). A judge's model that cannot take a file's kind is `[model.unsupported-input]`.

## A judge that reads the tool calls

`input.toolCalls` (#395) holds the agent's tool calls of the visit it judges — every attempt's, in
call order, with real values (the step's code sees them; the record keeps them masked). A judge can
fail an answer that no successful lookup backs, without a model call; `toolCallsOf(Tool,
toolCalls)` types one tool's calls by its input and output once narrowed by `status`.

<!-- snippet-context
import { Judge, JudgeVerdict, Tool, ToolCallStatus, toolCallsOf, type JudgeHandler, type JudgeInput } from "@agboss/core";
import { PlainTextDto, Text } from "@agboss/core/dto";
export class OrderQuery {
  @Text() orderId!: string;
}
export class OrderInfo {
  @Text() status!: string;
}
@Tool({ name: "get-order-tool", description: "An order", input: OrderQuery, output: OrderInfo })
export class GetOrderTool {
  execute({ orderId }: OrderQuery): Promise<OrderInfo> {
    return Promise.resolve({ status: `order ${orderId} shipped` });
  }
}
-->

```ts
@Judge({ name: "looked-up-judge", model: "typesafe/jev-1.13", output: PlainTextDto, deps: [JudgeModel] })
export class LookedUpJudge implements JudgeHandler<PlainTextDto> {
  judge({ output, toolCalls }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const lookups = toolCallsOf(GetOrderTool, toolCalls);
    const found = lookups.filter((call) => call.status === ToolCallStatus.Succeeded);
    const named = found.some((call) => output.text.includes(call.output.status));
    return Promise.resolve(
      named
        ? JudgeVerdict.passed({ metrics: { lookups: found.length } })
        : JudgeVerdict.failed("State the status the order lookup returned."),
    );
  }
}
```

`testUnit(LookedUpJudge)({ variant: PlainTextDto, output, task, attempt })` runs it with no calls
(`toolCalls` defaults to `[]`); pass `toolCalls: [record]` to judge a trajectory. Each verdict is in
the agent step's `result.record.steps[i].judgeVerdicts` (`judge`, `attempt`, `passed`, `reason?`,
`metrics?`).

## `[judge.wrong-output]`

The agent's answer and its judge's `output` have one shape — one value or a list — and every class
the agent may answer with must be one of the judge's `output` classes (or extend one), checked at
assembly with the other rules — before any model call, also by `agboss check`:

- a text agent with a DTO judge (`answers text (no output: PlainTextDto), but its judge … judges JobReportDto`);
- a DTO agent with a judge of another class, or with a `PlainTextDto` judge;
- a `oneOf(A, B)` output whose judge judges `A` only (`it does not judge B`);
- a list agent with a judge of one value (`the agent answers a list: set @Judge({ output: listOf(…) })`);
- one value with a list judge (`the judge judges a list, but the agent answers one value`).

## `[judge.same-model-family]`

A model judges answers of its own family too kindly (self-preference), so a model judge whose model
has the judged agent's vendor prefix — the slug's first part, `openai` of `openai/gpt-6` — is the
warning `[judge.same-model-family]` (#396 PR 5, S2 Q9), printed by `agboss check` and an error under
`agboss check --strict`:

```
judge-family-workflow: open-ai-judge (openai/gpt-6) judges writer-agent, whose model openai/gpt-6-mini is of the same family (openai) — a judge grades its own family's answers too kindly: give the judge a model of another vendor
```

An agent's judges are read against that agent's model; an [eval suite](Eval-Suites)'s judges against
every agent of the workflow its start opens. A code judge has no model, and a model id without a
known vendor has no family — neither is compared. A model id is read as it names its vendor (`openai/gpt-6`,
or `gpt-6`, `o3`, `claude-…`, `gemini-…`, `deepseek…`, `qwen…`, `llama…`, `mistral…`, `grok-…`), after a role such
as `fast` is resolved through the judge's or the agent's own `modelProvider`; one model name on one endpoint
(`baseUrl`) is one family whatever its name. The fix: a judge model of another vendor
(a decision model such as `typesafe/jev-1.13`), or a code judge for what code can check.

## `[judge.zero-retries]`

An agent with `judges` and `executionLimits.maxRetries` unset or `0` fails the run at its first rejection: the judge's
reason never reaches the model. That is the warning `[judge.zero-retries]` (an error under `--strict`) —
set `executionLimits.maxRetries` so a rejected answer gets another try.

## Adding judges to an agent

```ts
import { Agent, inline } from "@agboss/core";
import { CorrectnessJudge } from "./judges/correctness.judge.js";
import { GroundedJudge } from "./judges/grounded.judge.js";
import { OneSentenceJudge } from "./judges/one-sentence.judge.js";

@Agent({
  name: "writer-agent",
  description: "Writes the answer",
  prompt: inline("Write the answer to the task."),
  model: "moonshotai/kimi-k2.6",
  judges: [OneSentenceJudge, CorrectnessJudge, GroundedJudge], // a text agent: all judge PlainTextDto
  executionLimits: { maxRetries: 2 },
})
export class WriterAgent {}
```

The judges are registered by the agent; list a judge's own dependencies in the workflow's
`providers`.

## How it works

1. The agent's loop produces its answer: text, or a DTO through its answer tool, validated.
2. Every judge of the agent runs on it, each with its own copy (observers see `onJudgeStart` /
   `onJudgeEnd`, the verdict as `update`).
3. A failed verdict's `reason` goes back to the agent's model (`- [<judge>] <reason>`), and the loop
   runs again — until every judge passes or `maxRetries` retries are spent (`QualityGateError`,
   `rejections` of the last answer).

A model judge's calls read as the judged agent's model reads (#708): what `judgeModel.invoke` sends
(a text or messages) and what `judgeModel.decide` sends (the state and the questions) go through that
agent's PII policies, with its execution's sensitive values and key, and a chat reply's tokens are
revealed before `judge()` reads it — the judge sees `alice@example.com`, its model `<email:7f3a91>`.
The masking's spend is the judge's. A model arbiter of a quorum reads each answer through the
answering agent's policies the same way — every copy of a launch (`critic-agent#2`) through its
agent's, and an element no list names through the workflow's policies, never through none. An eval suite's judge runs outside any agent and is not
masked.

In tests, script a chat judge like an agent — `mockLlm(CorrectnessJudge).thenReturn(replyWith("PASS"))`
— and a decision judge with its answers by question id:
`mockLlm(GroundedJudge).thenReturn(decideWith({ grounded: 0.9, quality: 2 }))`. On its own,
`testUnit(AnswerGroundedJudge, …)({ variant: JobReportDto, output, task, attempt })` takes `output` as
a plain object of the judge's DTO, typed by the judge — a `variant` with another class's value
(`{ variant: OfferDto, output: { why } }`) does not compile ([Testing](Testing#unit-runners--one-component-on-its-own)).
