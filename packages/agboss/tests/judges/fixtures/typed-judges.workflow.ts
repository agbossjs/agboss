import {
  Agent,
  Injectable,
  Judge,
  JudgeModel,
  JudgeVerdict,
  Workflow,
  WorkflowFinish,
  type JudgeHandler,
  type JudgeInput,
  inline,
  Ttl,
} from "../../../src/index.js";
import { Integer, List, PlainTextDto, Text, type DtoClass } from "../../../src/dto/index.js";
import { listOf, oneOf } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { onStart, toFinish, toAgent } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { DEFAULTS, MODEL_PROVIDERS, Reply, TaskStart } from "./judged.workflow.js";
import { LocalModelProvider } from "../../models/providers.fixture.js";

/** One job of a report. */
export class JobDto {
  @Text({ prompt: "the job's title" })
  title!: string;

  @Text({ prompt: "where the job is posted" })
  url!: string;
}

/** What the scout found. */
export class JobReportDto {
  @List(JobDto, { prompt: "the jobs found" })
  jobs!: JobDto[];
}

/** Whether a job is still posted — a service the judge depends on, replaced by `mockService` in tests. */
@Injectable()
export class JobSearch {
  exists(url: string): Promise<boolean> {
    return Promise.resolve(url.length > 0);
  }
}

/** The classes judges were given as `variant` (S125) — replaced by `mockService` in tests. */
@Injectable()
export class VariantLog {
  seen(variant: DtoClass): DtoClass {
    return variant;
  }
}

/** S115's judge: it reads the report as its DTO, not as text. */
@Judge({
  name: "answer-grounded-judge",
  model: "local/judge",
  output: JobReportDto,
  deps: [JudgeModel, JobSearch, VariantLog],
})
export class AnswerGroundedJudge implements JudgeHandler<JobReportDto> {
  constructor(
    private readonly judgeModel: JudgeModel,
    private readonly jobSearch: JobSearch,
    private readonly variantLog: VariantLog,
  ) {}

  async judge({ variant, output }: JudgeInput<JobReportDto>): Promise<JudgeVerdict> {
    this.variantLog.seen(variant);
    const [first] = output.jobs;
    if (first === undefined) return JudgeVerdict.failed("the report has no jobs");
    const found: boolean = await this.jobSearch.exists(first.url);
    return found
      ? JudgeVerdict.passed({ metrics: { jobs: output.jobs.length, model: this.judgeModel.model } })
      : JudgeVerdict.failed("the first job does not exist");
  }
}

@Agent({
  name: "scout-agent",
  prompt: inline("Find jobs."),
  description: "Finds jobs",
  model: "local/llama",
  output: JobReportDto,
  judges: [AnswerGroundedJudge],
  executionLimits: { maxRetries: 1 },
})
export class ScoutAgent {}

@WorkflowFinish({
  name: "report-workflow-finish",
  description: "The report",
  output: JobReportDto,
})
export class ReportWorkflowFinish {}

@Workflow({
  name: "typed-judge-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(TaskStart).toAgent(ScoutAgent).toFinish(ReportWorkflowFinish)],
  defaults: DEFAULTS,
  providers: [JobSearch, VariantLog],
})
export class TypedJudgeWorkflow {}

@Application({
  name: "typed-judge-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  workflows: [TypedJudgeWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class TypedJudgeApplication {}

/** An offer the screener makes. */
export class OfferDto {
  @Integer({ prompt: "the salary offered" })
  salary!: number;
}

/** A refusal the screener gives. */
export class RefusalDto {
  @Text({ prompt: "why the candidate is refused" })
  why!: string;
}

/**
 * Judges both variants (S125): `variant` is the class the answer validated as; `output instanceof
 * OfferDto` narrows `output` to `OfferDto`, the other branch to `RefusalDto`.
 */
@Judge({
  name: "fair-decision-judge",
  model: "local/judge",
  output: oneOf(OfferDto, RefusalDto),
  deps: [VariantLog, JudgeModel],
})
export class FairDecisionJudge implements JudgeHandler<OfferDto | RefusalDto> {
  constructor(private readonly variantLog: VariantLog) {}

  judge(input: JudgeInput<OfferDto | RefusalDto>): Promise<JudgeVerdict> {
    this.variantLog.seen(input.variant);
    if (input.output instanceof OfferDto) {
      const { salary } = input.output;
      return Promise.resolve(
        salary > 0
          ? JudgeVerdict.passed({ metrics: { salary } })
          : JudgeVerdict.failed("an offer pays something"),
      );
    }
    return Promise.resolve(
      input.output.why.trim().length > 0
        ? JudgeVerdict.passed()
        : JudgeVerdict.failed("a refusal says why"),
    );
  }
}

@Agent({
  name: "screener-agent",
  prompt: inline("Decide."),
  description: "Offers or refuses",
  model: "local/llama",
  output: oneOf(OfferDto, RefusalDto),
  judges: [FairDecisionJudge],
  executionLimits: { maxRetries: 1 },
})
export class ScreenerAgent {}

@WorkflowFinish({ name: "offer-workflow-finish", description: "An offer", output: OfferDto })
export class OfferWorkflowFinish {}

@WorkflowFinish({ name: "refusal-workflow-finish", description: "A refusal", output: RefusalDto })
export class RefusalWorkflowFinish {}

@Workflow({
  name: "variant-judge-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TaskStart)
      .toAgent(ScreenerAgent)
      .toOneOf([toFinish(OfferWorkflowFinish), toFinish(RefusalWorkflowFinish)]),
  ],
  defaults: DEFAULTS,
  providers: [VariantLog],
})
export class VariantJudgeWorkflow {}

@Application({
  name: "variant-judge-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  workflows: [VariantJudgeWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class VariantJudgeApplication {}

/** Judges one variant only. */
@Judge({ name: "offer-only-judge", model: "local/judge", output: OfferDto, deps: [JudgeModel] })
export class OfferOnlyJudge implements JudgeHandler<OfferDto> {
  judge(): Promise<JudgeVerdict> {
    return Promise.resolve(JudgeVerdict.passed());
  }
}

/** Judges text. */
@Judge({ name: "text-judge", model: "local/judge", output: PlainTextDto, deps: [JudgeModel] })
export class TextJudge implements JudgeHandler<PlainTextDto> {
  judge({ output }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    return Promise.resolve(
      output.text.length > 0 ? JudgeVerdict.passed() : JudgeVerdict.failed("empty"),
    );
  }
}

@Agent({
  name: "offer-judged-screener-agent",
  prompt: inline("Decide."),
  description: "Offers or refuses, judged on offers only",
  model: "local/llama",
  output: oneOf(OfferDto, RefusalDto),
  judges: [OfferOnlyJudge],
})
export class OfferJudgedScreenerAgent {}

@Agent({
  name: "report-judged-writer-agent",
  prompt: inline("Write."),
  description: "Answers text, judged as a report",
  model: "local/llama",
  judges: [AnswerGroundedJudge],
})
export class ReportJudgedWriterAgent {}

@Agent({
  name: "text-judged-scout-agent",
  prompt: inline("Find jobs."),
  description: "Answers a report, judged as text",
  model: "local/llama",
  output: JobReportDto,
  judges: [TextJudge],
})
export class TextJudgedScoutAgent {}

@Agent({
  name: "list-judged-scout-agent",
  prompt: inline("Find jobs."),
  description: "Answers a list of jobs",
  model: "local/llama",
  output: listOf(JobDto),
  judges: [AnswerGroundedJudge],
})
export class ListJudgedScoutAgent {}

/** Every way an agent's output does not fit its judge's reply. */
@Workflow({
  name: "wrong-reply-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TaskStart)
      .toAgent(OfferJudgedScreenerAgent)
      .toOneOf([toFinish(OfferWorkflowFinish), toAgent(ReportJudgedWriterAgent).toFinish(Reply)]),
  ],
  defaults: DEFAULTS,
  providers: [JobSearch, VariantLog],
})
export class WrongReplyWorkflow {}

/** A report judged as text. */
@Workflow({
  name: "wrong-report-reply-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(TaskStart).toAgent(TextJudgedScoutAgent).toFinish(ReportWorkflowFinish)],
  defaults: DEFAULTS,
})
export class WrongReportReplyWorkflow {}

/** What the list's summary reads. */
@Agent({
  name: "jobs-summary-agent",
  prompt: inline("Summarize."),
  description: "Summarizes the jobs",
  model: "local/llama",
  input: { jobs: listOf(JobDto) },
})
export class JobsSummaryAgent {}

/** A list judged as one report. */
@Workflow({
  name: "wrong-list-reply-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TaskStart).toAgent(ListJudgedScoutAgent).toAgent(JobsSummaryAgent).toFinish(Reply),
  ],
  defaults: DEFAULTS,
  providers: [JobSearch, VariantLog],
})
export class WrongListReplyWorkflow {}

@Application({
  name: "wrong-reply-application",
  version: "1.0.0",
  workflows: [WrongReplyWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class WrongReplyApplication {}

/** Judges a list of jobs: the reply is `readonly JobDto[]`, its `variant` the list's one class. */
@Judge({
  name: "jobs-judge",
  model: "local/judge",
  output: listOf(JobDto),
  deps: [JobSearch, VariantLog, JudgeModel],
})
export class JobsJudge implements JudgeHandler<readonly JobDto[]> {
  constructor(
    private readonly jobSearch: JobSearch,
    private readonly variantLog: VariantLog,
  ) {}

  async judge({ variant, output }: JudgeInput<readonly JobDto[]>): Promise<JudgeVerdict> {
    this.variantLog.seen(variant);
    const found: readonly boolean[] = await Promise.all(
      output.map((job) => this.jobSearch.exists(job.url)),
    );
    return found.length > 0 && found.every(Boolean)
      ? JudgeVerdict.passed({ metrics: { jobs: output.length } })
      : JudgeVerdict.failed("every job must still be posted");
  }
}

@Agent({
  name: "jobs-scout-agent",
  prompt: inline("Find jobs."),
  description: "Finds a list of jobs",
  model: "local/llama",
  output: listOf(JobDto),
  judges: [JobsJudge],
  executionLimits: { maxRetries: 1 },
})
export class JobsScoutAgent {}

@Workflow({
  name: "list-judge-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(TaskStart).toAgent(JobsScoutAgent).toAgent(JobsSummaryAgent).toFinish(Reply)],
  defaults: DEFAULTS,
  providers: [JobSearch, VariantLog],
})
export class ListJudgeWorkflow {}

@Application({
  name: "list-judge-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  workflows: [ListJudgeWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class ListJudgeApplication {}

/** The reply of a list of decisions: each item an instance of its class (S125). */
type Decisions = readonly (OfferDto | RefusalDto)[];

/** Judges a list of decisions, each an offer or a refusal: each item is an instance of its class. */
@Judge({
  name: "decisions-judge",
  model: "local/judge",
  output: listOf(OfferDto, RefusalDto),
  deps: [VariantLog, JudgeModel],
})
export class DecisionsJudge implements JudgeHandler<Decisions> {
  constructor(private readonly variantLog: VariantLog) {}

  judge({ output }: JudgeInput<Decisions>): Promise<JudgeVerdict> {
    for (const decision of output)
      this.variantLog.seen(decision instanceof OfferDto ? OfferDto : RefusalDto);
    const salaries: readonly number[] = output.flatMap((decision) =>
      decision instanceof OfferDto ? [decision.salary] : [],
    );
    return Promise.resolve(
      salaries.length <= 1
        ? JudgeVerdict.passed({ metrics: { offers: salaries.length } })
        : JudgeVerdict.failed("make at most one offer"),
    );
  }
}

@Agent({
  name: "panel-screener-agent",
  prompt: inline("Decide on each candidate."),
  description: "Offers or refuses, per candidate",
  model: "local/llama",
  output: listOf(OfferDto, RefusalDto),
  judges: [DecisionsJudge],
  executionLimits: { maxRetries: 1 },
})
export class PanelScreenerAgent {}

@Agent({
  name: "decisions-summary-agent",
  prompt: inline("Summarize."),
  description: "Summarizes the decisions",
  model: "local/llama",
  input: { decisions: listOf(OfferDto, RefusalDto) },
})
export class DecisionsSummaryAgent {}

@Workflow({
  name: "variant-list-judge-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TaskStart).toAgent(PanelScreenerAgent).toAgent(DecisionsSummaryAgent).toFinish(Reply),
  ],
  defaults: DEFAULTS,
  providers: [VariantLog],
})
export class VariantListJudgeWorkflow {}

@Application({
  name: "variant-list-judge-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  workflows: [VariantListJudgeWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class VariantListJudgeApplication {}

@Agent({
  name: "list-judged-reporter-agent",
  prompt: inline("Find jobs."),
  description: "Answers one report, judged as a list",
  model: "local/llama",
  output: JobReportDto,
  judges: [JobsJudge],
})
export class ListJudgedReporterAgent {}

/** One value judged as a list. */
@Workflow({
  name: "wrong-value-reply-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(TaskStart).toAgent(ListJudgedReporterAgent).toFinish(ReportWorkflowFinish)],
  defaults: DEFAULTS,
  providers: [JobSearch, VariantLog],
})
export class WrongValueReplyWorkflow {}
