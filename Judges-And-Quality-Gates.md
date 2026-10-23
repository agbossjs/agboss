# Judges and Quality Gates

A judge checks an agent's answer before it leaves the agent. A rejected answer goes back to the
agent with the judge's `reason` — inside the agent's own loop, so the checkpoint history does not
fill up with failed attempts — and once `maxRetries` retries are spent the run throws
`QualityGateError` (`code: "step.agent.quality-gate"`, `rejections: [{ judge, reason }]`).

## A judge

A `@Judge({ name, model, reply, deps })` class implements `JudgeHandler<TReply>`; the container
creates it with its `deps`, and its **own** model is called through the model gateway, so its spend
is in the run's cost report (`judge:<name>`). A model judge without a model fails at app start
(`[judge.no-model]`); a judge decided by code has none
([A code judge](#a-code-judge--decidedby-decidedbycode-396)).

A judge sees the agent's answer **as its DTO** (#262 S115). `reply` declares what it judges, in
every shape an agent's `output` has:

| `reply`               | The agent it judges                    | `input.reply` is                                    | `input.variant` is                    |
| --------------------- | -------------------------------------- | --------------------------------------------------- | ------------------------------------- |
| `JobReportDto`        | `output: JobReportDto`                 | the validated `JobReportDto`                        | `JobReportDto`                        |
| `oneOf(A, B)`         | `output: oneOf(A, B)` (or `A`, or `B`) | the variant's value, `A` or `B`                     | `A` or `B` — the class it answered as |
| `listOf(JobDto)`      | `output: listOf(JobDto)`               | the items, `readonly JobDto[]`                      | `JobDto`                              |
| `listOf(oneOf(A, B))` | `output: listOf(oneOf(A, B))`          | each item `{ variant, value }`, `readonly VariantOf<A \| B>[]` | — (each item has its own)  |
| `PlainTextDto`        | a text agent (no `output`)             | `{ text }` — its reply                              | `PlainTextDto`                        |

`judge(input)` gets what it judges as data (`JudgeInput<TReply>`: `variant`, `reply`, `task` — the
agent's input message, `attempt` — retries so far) and nothing else (#280: no `JudgeContext`); each judge
gets its own copy of the answer, so none changes what the step gives. Its model comes through the
constructor — `deps: [JudgeModel]`, each call going to the model of the judge whose `judge()` runs
(used anywhere else it throws `[judge.model-outside-judge]`); the execution, like in any component,
through `deps: [ExecutionContext]` (the judged agent is `step.component`).

A verdict is built only with **`JudgeVerdict.passed({ metrics? })`** or
**`JudgeVerdict.failed({ reason, metrics? })`** — a plain object does not compile (one way). A
failed verdict's `reason` is what the agent reads before its retry.

```ts file=judges/correctness.judge.ts
import {
  Judge,
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
} from "agboss";
import { PlainTextDto } from "agboss/dto";

@Judge({
  name: "correctness-judge",
  model: "moonshotai/kimi-k2.6",
  reply: PlainTextDto, // a text agent's reply: { text }
  deps: [JudgeModel],
})
export class CorrectnessJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply, task, attempt }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const verdict = await this.judgeModel.invoke(
      `Task: ${task}\nReply: ${reply.text}\nAnswer PASS if the reply is correct and complete, else explain what is wrong.`,
    );
    return verdict.trim().startsWith("PASS")
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed({ reason: verdict, metrics: { attempt } });
  }
}
```

On a **decision model** the judge asks typed questions instead — `judgeModel.decide({ state, questions })`
with `Decision.noul` (yes/no → P(yes)), `Decision.choice` (an option, probabilities, confidence) and
`Decision.score` (levels, lowest first → the level's index); the answers are typed by the questions:

```ts file=judges/grounded.judge.ts
import {
  Decision,
  Judge,
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
} from "agboss";
import { PlainTextDto } from "agboss/dto";

@Judge({
  name: "grounded-judge",
  model: "openai/gpt-6-luna-decisions",
  reply: PlainTextDto,
  deps: [JudgeModel],
})
export class GroundedJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply, task }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const a = await this.judgeModel.decide({
      state: { task, reply: reply.text },
      questions: {
        grounded: Decision.noul("Every fact in the reply follows from the task"),
        quality: Decision.score("Overall usefulness", ["useless", "partial", "complete"]),
      },
    });
    return a.grounded.noul > 0.7 && a.quality.score >= 1
      ? JudgeVerdict.passed({ metrics: { quality: a.quality.score } })
      : JudgeVerdict.failed({ reason: "Only state facts you can support, and answer the whole task." });
  }
}
```

`decide` on a chat model or `invoke` on a decision model throws `ModelKindError` (`model.wrong-kind`).

## A code judge — `decidedBy: DecidedBy.Code` (#396)

A judge whose rule is code — a length, a format, a side effect a service can look up — needs no
model: `@Judge({ decidedBy: DecidedBy.Code })` decides by its `judge(input)` alone. No model call,
cost 0, nothing to script; its services and the execution come through `deps` like any component's.
`decidedBy` is absent on a model judge (`DecidedBy.Model`, the default) — the options are
discriminated: a model judge requires `model`, on a code judge `model` does not compile. A code judge
that names a `model` anyway (plain JS) or injects `JudgeModel` fails assembly with
`[judge.model-on-code-judge]`; a `JudgeModel` reached through a service throws the same code when
called. It runs in an agent's quality gate beside model judges — list the free one first, every
judge runs — and in an eval suite's checks ([Eval suites](Eval-Suites)).

```ts file=judges/one-sentence.judge.ts
import { DecidedBy, ExecutionContext, Judge, JudgeVerdict, type JudgeHandler, type JudgeInput } from "agboss";
import { PlainTextDto } from "agboss/dto";

@Judge({
  name: "one-sentence-judge",
  description: "The reply is one sentence",
  decidedBy: DecidedBy.Code, // no model, no cost
  reply: PlainTextDto,
  deps: [ExecutionContext],
})
export class OneSentenceJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly executionContext: ExecutionContext) {}

  judge({ reply }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const sentences: number = reply.text.split(/[.!?](\s|$)/u).filter((part) => part.trim() !== "").length;
    const tenant: string = this.executionContext.tenant.tenantId;
    return Promise.resolve(
      sentences <= 1
        ? JudgeVerdict.passed({ metrics: { sentences, tenant } })
        : JudgeVerdict.failed({ reason: "answer in one sentence" }),
    );
  }
}
```

In tests a code judge has no script — `mockLlm(OneSentenceJudge)` fails, naming why ("a code judge
calls no model — mockOf() the services its judge() uses"); `testJudge(OneSentenceJudge)` runs it with
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
} from "agboss";
import { ListOf, Text } from "agboss/dto";

export class JobDto {
  @Text({ prompt: "the job's title" })
  title!: string;

  @Text({ prompt: "where the job is posted" })
  url!: string;
}

export class JobReportDto {
  @ListOf(JobDto, { prompt: "the jobs found" })
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
  reply: JobReportDto,
  deps: [JudgeModel, JobSearch],
})
export class AnswerGroundedJudge implements JudgeHandler<JobReportDto> {
  constructor(
    private readonly judgeModel: JudgeModel,
    private readonly jobSearch: JobSearch,
  ) {}

  async judge({ reply }: JudgeInput<JobReportDto>): Promise<JudgeVerdict> {
    const [first] = reply.jobs;
    const found: boolean = first !== undefined && (await this.jobSearch.exists(first.url));
    return found
      ? JudgeVerdict.passed({ metrics: { jobs: reply.jobs.length } })
      : JudgeVerdict.failed({ reason: "the first job does not exist" });
  }
}
```

### The variant of a `oneOf` reply

`input.variant` is the class the answer validated as (#262 S125): the class of the answer tool the
agent used — never guessed from the answer's shape, never compared by name. For a
`oneOf(OfferDto, RefusalDto)` judge `JudgeInput<OfferDto | RefusalDto>` is a discriminated union —
`{ variant: typeof OfferDto; reply: OfferDto; … } | { variant: typeof RefusalDto; reply: RefusalDto; … }` —
and `isVariant(input, OfferDto)` narrows `reply` to `OfferDto` (the other branch to `RefusalDto`).
`input.variant === OfferDto` is true at run time too, but TypeScript narrows an object only on a
literal discriminant, never on a class, so `isVariant` is the way to narrow:

<!-- snippet-context
import { Integer, Text } from "agboss/dto";
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
import { Judge, JudgeVerdict, type JudgeHandler, type JudgeInput } from "agboss";
import { isVariant, oneOf } from "agboss/dto";

@Judge({ name: "fair-decision-judge", model: "typesafe/jev-1.13", reply: oneOf(OfferDto, RefusalDto) })
export class FairDecisionJudge implements JudgeHandler<OfferDto | RefusalDto> {
  judge(input: JudgeInput<OfferDto | RefusalDto>): Promise<JudgeVerdict> {
    if (isVariant(input, OfferDto)) {
      // the agent answered through answer-offer-dto: input.reply is an OfferDto
      return Promise.resolve(
        input.reply.salary > 0
          ? JudgeVerdict.passed({ metrics: { salary: input.reply.salary } })
          : JudgeVerdict.failed({ reason: "an offer pays something" }),
      );
    }
    // input.variant is RefusalDto, input.reply a RefusalDto
    return Promise.resolve(
      input.reply.why.trim() === ""
        ? JudgeVerdict.failed({ reason: "a refusal says why" })
        : JudgeVerdict.passed(),
    );
  }
}
```

A judge of one class has `variant` as that class (a subclass the agent answered with, when its
`output` extends the judge's `reply`), a text judge `PlainTextDto`, a `listOf(XDto)` judge the
list's one class. A `listOf(oneOf(A, B))` judge has no `variant` of its own: its `reply` is
`readonly VariantOf<A | B>[]` — each item `{ variant, value }` (`VariantOf` from `agboss/dto`), as
the answer's items are kept — narrowed by `isVariant(item, A)`:

<!-- snippet-context
import { Integer, Text } from "agboss/dto";
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
import { Judge, JudgeVerdict, type JudgeHandler, type JudgeInput } from "agboss";
import { isVariant, listOf, oneOf, type VariantOf } from "agboss/dto";

type Decisions = readonly VariantOf<OfferDto | RefusalDto>[];

@Judge({
  name: "decisions-judge",
  model: "typesafe/jev-1.13",
  reply: listOf(oneOf(OfferDto, RefusalDto)),
})
export class DecisionsJudge implements JudgeHandler<Decisions> {
  judge({ reply }: JudgeInput<Decisions>): Promise<JudgeVerdict> {
    const salaries: readonly number[] = reply.flatMap((decision) =>
      isVariant(decision, OfferDto) ? [decision.value.salary] : [],
    );
    return Promise.resolve(
      salaries.length <= 1
        ? JudgeVerdict.passed({ metrics: { offers: salaries.length } })
        : JudgeVerdict.failed({ reason: "make at most one offer" }),
    );
  }
}
```

A list agent's judge declares the list and gets its items (`variant` is `JobDto`):

```ts
import { Judge, JudgeVerdict, type JudgeHandler, type JudgeInput } from "agboss";
import { listOf } from "agboss/dto";
import { JobDto, JobSearch } from "./judges/answer-grounded.judge.js";

@Judge({ name: "jobs-judge", model: "typesafe/jev-1.13", reply: listOf(JobDto), deps: [JobSearch] })
export class JobsJudge implements JudgeHandler<readonly JobDto[]> {
  constructor(private readonly jobSearch: JobSearch) {}

  async judge({ reply }: JudgeInput<readonly JobDto[]>): Promise<JudgeVerdict> {
    const found: readonly boolean[] = await Promise.all(
      reply.map((job) => this.jobSearch.exists(job.url)),
    );
    return found.length > 0 && found.every(Boolean)
      ? JudgeVerdict.passed({ metrics: { jobs: reply.length } })
      : JudgeVerdict.failed({ reason: "every job must still be posted" });
  }
}
```

## A judge that reads the tool calls

`input.toolCalls` (#395) holds the agent's tool calls of the visit it judges — every attempt's, in
call order, with real values (the step's code sees them; the record keeps them masked). A judge can
fail an answer that no successful lookup backs, without a model call; `toolCallsOf(Tool,
toolCalls)` types one tool's calls by its input and output once narrowed by `status`.

<!-- snippet-context
import { Judge, JudgeVerdict, Tool, ToolCallStatus, toolCallsOf, type JudgeHandler, type JudgeInput, type ToolHandler } from "agboss";
import { PlainTextDto, Text } from "agboss/dto";
export class OrderQuery {
  @Text() orderId!: string;
}
export class OrderInfo {
  @Text() status!: string;
}
@Tool({ name: "get-order-tool", description: "An order", input: OrderQuery, output: OrderInfo })
export class GetOrderTool implements ToolHandler<OrderQuery, OrderInfo> {
  run({ orderId }: OrderQuery): Promise<OrderInfo> {
    return Promise.resolve({ status: `order ${orderId} shipped` });
  }
}
-->

```ts
@Judge({ name: "looked-up-judge", model: "typesafe/jev-1.13", reply: PlainTextDto })
export class LookedUpJudge implements JudgeHandler<PlainTextDto> {
  judge({ reply, toolCalls }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const lookups = toolCallsOf(GetOrderTool, toolCalls);
    const found = lookups.filter((call) => call.status === ToolCallStatus.Succeeded);
    const named = found.some((call) => reply.text.includes(call.output.status));
    return Promise.resolve(
      named
        ? JudgeVerdict.passed({ metrics: { lookups: found.length } })
        : JudgeVerdict.failed({ reason: "State the status the order lookup returned." }),
    );
  }
}
```

`testJudge(LookedUpJudge)({ variant: PlainTextDto, reply, task, attempt })` runs it with no calls
(`toolCalls` defaults to `[]`); pass `toolCalls: [record]` to judge a trajectory. Each verdict is in
the agent step's `result.record.steps[i].judgeVerdicts` (`judge`, `attempt`, `passed`, `reason?`,
`metrics?`).

## `[judge.wrong-reply]`

The agent's answer and its judge's `reply` have one shape — one value or a list — and every class
the agent may answer with must be one of the judge's `reply` classes (or extend one), checked at
assembly with the other rules — before any model call, also by `agboss check`:

- a text agent with a DTO judge (`answers text (no output: PlainTextDto), but its judge … judges JobReportDto`);
- a DTO agent with a judge of another class, or with a `PlainTextDto` judge;
- a `oneOf(A, B)` output whose judge judges `A` only (`it does not judge B`);
- a list agent with a judge of one value (`the agent answers a list: set @Judge({ reply: listOf(…) })`);
- one value with a list judge (`the judge judges a list, but the agent answers one value`).

## Adding judges to an agent

```ts
import { Agent } from "agboss";
import { CorrectnessJudge } from "./judges/correctness.judge.js";
import { GroundedJudge } from "./judges/grounded.judge.js";
import { OneSentenceJudge } from "./judges/one-sentence.judge.js";

@Agent({
  name: "writer-agent",
  description: "Writes the answer",
  prompt: "Write the answer to the task.",
  model: "moonshotai/kimi-k2.6",
  judges: [OneSentenceJudge, CorrectnessJudge, GroundedJudge], // a text agent: all judge PlainTextDto
  maxRetries: 2,
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

In tests, script a chat judge like an agent — `mockLlm(CorrectnessJudge).thenReturn(replyWith("PASS"))`
— and a decision judge with its answers by question id:
`mockLlm(GroundedJudge).thenReturn(decideWith({ grounded: 0.9, quality: 2 }))`. On its own,
`testJudge(AnswerGroundedJudge, …)({ variant: JobReportDto, reply, task, attempt })` takes `reply` as
a plain object of the judge's DTO, typed by the judge — a `variant` with another class's value
(`{ variant: OfferDto, reply: { why } }`) does not compile ([Testing](Testing#unit-runners--one-component-on-its-own)).
