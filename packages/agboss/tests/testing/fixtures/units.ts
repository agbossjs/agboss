/**
 * #262 PR 3 — components for the unit runners (`testUnit`, `testUnit`, `testUnit`, `testUnit`,
 * `testUnit`): each injects what the runner gives (`ExecutionContext`, `SpendRecorder`,
 * `JudgeModel`, `ApplicationContext`) and a service the tests replace with `override(…)`.
 */
import { RagScope } from "../../../src/rag/types.js";
import { RagSource } from "../../../src/rag/rag-source.js";
import {
  ApplicationContext,
  Decision,
  ExecutionContext,
  Injectable,
  InputGuardrail,
  Judge,
  JudgeModel,
  JudgeVerdict,
  PiiAction,
  PiiKind,
  PiiPolicy,
  SpendRecorder,
  TenantContext,
  Tool,
  type GuardrailRefusal,
  type JudgeHandler,
  type JudgeInput,
  type PiiMatch,
  type PiiPolicyHandler,
} from "../../../src/index.js";
import { Rag } from "../../../src/components/decorators.js";
import { Enum, PlainTextDto, Text } from "../../../src/dto/index.js";
import type { RagRetrieval } from "../../../src/rag/types.js";
import { seconds, usd } from "../../../src/units/index.js";

// ── services the tests replace ──

@Injectable()
export class JobBoardService {
  search(query: string): Promise<readonly string[]> {
    return Promise.reject(new Error(`the real job board was called for ${query}`));
  }
}

@Injectable()
export class FakeJobBoardService extends JobBoardService {
  override search(query: string): Promise<readonly string[]> {
    return Promise.resolve([`${query} engineer`, `${query} lead`]);
  }
}

/** Never answers until the call's signal aborts (a slow board). */
@Injectable({ deps: [ExecutionContext] })
export class SlowJobBoardService extends JobBoardService {
  constructor(private readonly executionContext: ExecutionContext) {
    super();
  }

  override search(): Promise<readonly string[]> {
    const { signal } = this.executionContext;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new Error(`the board saw the abort: ${String(signal.reason)}`));
      });
    });
  }
}

// ── a tool ──

export class JobSearch {
  @Text({ prompt: "what to search" })
  query!: string;
}

export class JobList {
  @Text({ prompt: "the jobs found, one per line" })
  jobs!: string;
  @Text({ prompt: "who asked" })
  step!: string;
}

@Tool({
  name: "search-jobs-tool",
  description: "Searches the job board",
  input: JobSearch,
  output: JobList,
  timeout: seconds(5),
  deps: [ExecutionContext, SpendRecorder, JobBoardService],
})
export class SearchJobsTool {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
    private readonly jobBoardService: JobBoardService,
  ) {}

  async execute({ query }: JobSearch): Promise<JobList> {
    const jobs = await this.jobBoardService.search(query);
    this.spendRecorder.record({ service: "job-board", cost: usd(0.002) });
    const { step } = this.executionContext;
    return { jobs: jobs.join("\n"), step: `${step.nodeId}:${step.callId ?? ""}` };
  }
}

/** A tool whose result does not fit its output DTO. */
@Tool({
  name: "broken-jobs-tool",
  description: "Answers garbage",
  input: JobSearch,
  output: JobList,
})
export class BrokenJobsTool {
  execute(): Promise<JobList> {
    return Promise.resolve({ jobs: "x" } as JobList);
  }
}

// ── judges ──

@Judge({
  name: "grounded-judge",
  model: "typesafe/jev-1.13",
  output: PlainTextDto,
  deps: [JudgeModel],
})
export class GroundedJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ output, task }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const answers = await this.judgeModel.decide({
      state: { task, output: output.text },
      questions: {
        grounded: Decision.boolean("Is every claim of the reply grounded in the task?"),
      },
    });
    return answers.grounded.probability > 0.5
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed("cite the source of every claim");
  }
}

@Judge({
  name: "tone-judge",
  model: "moonshotai/kimi-k2.6",
  output: PlainTextDto,
  deps: [JudgeModel],
})
export class ToneJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ output }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const said = await this.judgeModel.invoke(
      `Is this polite? Answer PASS or FAIL.\n${output.text}`,
    );
    return said.trim() === "PASS" ? JudgeVerdict.passed() : JudgeVerdict.failed("rude");
  }
}

// ── a knowledge base ──

@Rag({
  name: "handbook",
  description: "The team handbook",
  scope: RagScope.Tenant,
  topK: 2,
  deps: [JobBoardService],
})
export class HandbookRag extends RagSource {
  constructor(private readonly jobBoardService: JobBoardService) {
    super();
  }

  protected override async retrieve(
    query: string,
    options: { readonly topK: number; readonly signal: AbortSignal },
  ): Promise<RagRetrieval> {
    const found = await this.jobBoardService.search(query);
    const results = found.slice(0, options.topK).map((text, index) => ({
      source: `handbook#${String(index + 1)}`,
      text,
    }));
    return { results, costUsd: usd(0.001) };
  }
}

// ── a guardrail ──

/**
 * Blocks requests for legal advice; its refusal names the environment and the step it ran in — read
 * from the contexts it injects, as an application's step would give them.
 */
@InputGuardrail({
  name: "legal-advice-guardrail",
  description: "Blocks requests for legal advice",
  prompt: "Does the message ask for legal advice?",
  model: "typesafe/jev-1.13",
  threshold: 0.8,
  deps: [ApplicationContext, ExecutionContext],
})
export class LegalAdviceGuardrail implements GuardrailRefusal {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
  ) {}

  refusal(): string {
    const { environmentName } = this.applicationContext;
    return `No legal advice (${environmentName}, ${this.executionContext.step.nodeId}).`;
  }
}

// ── PII policies ──

@PiiPolicy({
  name: "contact-pii-policy",
  description: "Hides contact details",
  rules: [PiiKind.Email.tokenize(), PiiKind.Phone.mask({ keepLast: 2 })],
})
export class ContactPiiPolicy {}

@PiiPolicy({
  name: "card-pii-policy",
  description: "Refuses card numbers",
  rules: [PiiKind.CardNumber.block("No cards here.")],
})
export class CardPiiPolicy {}

@PiiPolicy({
  name: "name-pii-policy",
  description: "Finds people's names with a model",
  rules: [PiiKind.PersonName.mask()],
  model: "moonshotai/kimi-k2.6",
})
export class NamePiiPolicy {}

/** A project's detector: the staff ids its directory knows. */
@Injectable()
export class StaffDirectory {
  ids(): readonly string[] {
    return ["S-001"];
  }
}

@PiiPolicy({
  name: "staff-id-pii-policy",
  action: PiiAction.tokenize(),
  deps: [StaffDirectory],
})
export class StaffIdPiiPolicy implements PiiPolicyHandler {
  constructor(private readonly staffDirectory: StaffDirectory) {}

  findMatches(text: string): readonly PiiMatch[] {
    return this.staffDirectory.ids().flatMap((id) => {
      const start = text.indexOf(id);
      return start === -1 ? [] : [{ start, end: start + id.length }];
    });
  }
}

/** A name that is not kebab-case: `[name.not-kebab-case]`. */
@PiiPolicy({
  name: "Contact_Policy",
  description: "Misnamed",
  rules: [PiiKind.Email.mask()],
})
export class MisnamedPolicy {}

// ── the project's context levels ──

export class ShopTenantContext extends TenantContext {
  @Enum(["free", "pro"])
  plan!: "free" | "pro";
}

export class ShopExecutionContext extends ExecutionContext {
  @Text()
  userId!: string;
}

export class PlanReport {
  @Text({ prompt: "who asked, on which plan" })
  summary!: string;
}

/** Reads the tenant's plan and the execution's user through the project's own classes. */
@Tool({
  name: "plan-report-tool",
  description: "Says the caller's plan",
  input: JobSearch,
  output: PlanReport,
  deps: [ShopTenantContext, ShopExecutionContext],
})
export class PlanReportTool {
  constructor(
    private readonly shopTenantContext: ShopTenantContext,
    private readonly shopExecutionContext: ShopExecutionContext,
  ) {}

  execute(): Promise<PlanReport> {
    const { tenantId, plan } = this.shopTenantContext;
    const { userId } = this.shopExecutionContext;
    return Promise.resolve({ summary: `${userId}@${tenantId}: ${plan}` });
  }
}
