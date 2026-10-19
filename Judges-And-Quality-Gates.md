# Judges and Quality Gates

A judge checks an agent's answer before it leaves the agent. A rejected answer goes back to the
agent with the judge's `reason` — inside the agent's own loop, so the checkpoint history does not
fill up with failed attempts — and once `maxRetries` retries are spent the run throws
`QualityGateError` (`code: "step.agent.quality-gate"`, `rejections: [{ judge, reason }]`).

## A judge

A `@Judge({ name, model, reply, deps })` class implements `JudgeHandler<TReply>`; the container
creates it with its `deps`, and its **own** model is called through the model gateway, so its spend
is in the run's cost report (`judge:<name>`). A judge without a model fails at app start
(`[judge.no-model]`).

A judge sees the agent's answer **as its DTO** (#262 S115). `reply` declares what it judges, in
every shape an agent's `output` has:

| `reply`              | The agent it judges                   | `input.reply` is                      |
| -------------------- | ------------------------------------- | ------------------------------------- |
| `JobReportDto`       | `output: JobReportDto`                | the validated `JobReportDto`          |
| `oneOf(A, B)`        | `output: oneOf(A, B)` (or `A`, or `B`) | the variant's value, typed `A \| B`   |
| `listOf(JobDto)`     | `output: listOf(JobDto)`              | the items, `readonly JobDto[]`        |
| `listOf(oneOf(A, B))` | `output: listOf(oneOf(A, B))`        | each item's value, `readonly (A \| B)[]` |
| `PlainTextDto`       | a text agent (no `output`)            | `{ text }` — its reply                |

`judge(input)` gets what it judges as data (`JudgeInput<TReply>`: `reply`, `task` — the agent's
input message, `attempt` — retries so far) and nothing else (#280: no `JudgeContext`); each judge
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

A `oneOf(OfferDto, RefusalDto)` judge gets `OfferDto | RefusalDto` and tells them apart by their
fields (`"salary" in reply`). A list agent's judge declares the list and gets its items:

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

@Agent({
  name: "writer-agent",
  description: "Writes the answer",
  prompt: "Write the answer to the task.",
  model: "moonshotai/kimi-k2.6",
  judges: [CorrectnessJudge, GroundedJudge], // a text agent: both judge PlainTextDto
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
`testJudge(AnswerGroundedJudge, …)({ reply, task, attempt })` takes `reply` as a plain object of the
judge's DTO, typed by the judge ([Testing](Testing#unit-runners--one-component-on-its-own)).
