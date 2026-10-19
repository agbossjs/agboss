/**
 * #262 PR 3 — components for the unit runners (`testTool`, `testJudge`, `testPii`, `testRag`,
 * `testGuardrail`): each injects what the runner gives (`ExecutionContext`, `SpendRecorder`,
 * `JudgeModel`, `ApplicationContext`) and a service the tests replace with `override(…)`.
 */
import {
  ApplicationContext,
  Decision,
  ExecutionContext,
  Guardrail,
  Injectable,
  Judge,
  JudgeModel,
  PiiAction,
  PiiKind,
  PiiPolicy,
  SpendRecorder,
  TenantContext,
  Tool,
  pii,
  type GuardrailContext,
  type JudgeHandler,
  type JudgeInput,
  type JudgeVerdict,
  type PiiMatch,
  type PiiPolicyHandler,
  type ToolHandler,
} from "../../../src/index.js";
import { Rag } from "../../../src/components/decorators.js";
import { OneOf, Text } from "../../../src/dto/index.js";
import type { RagConnector, RagRetrieval } from "../../../src/rag/types.js";
import { usd } from "../../../src/units/index.js";

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
  name: "search_jobs",
  description: "Searches the job board",
  input: JobSearch,
  output: JobList,
  timeoutMs: 5_000,
  deps: [ExecutionContext, SpendRecorder, JobBoardService],
})
export class SearchJobsTool implements ToolHandler<JobSearch, JobList> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
    private readonly jobBoardService: JobBoardService,
  ) {}

  async run({ query }: JobSearch): Promise<JobList> {
    const jobs = await this.jobBoardService.search(query);
    this.spendRecorder.record({ service: "job-board", cost: usd(0.002) });
    const { step } = this.executionContext;
    return { jobs: jobs.join("\n"), step: `${step.nodeId}:${step.callId ?? ""}` };
  }
}

/** A tool whose result does not fit its output DTO. */
@Tool({ name: "broken_jobs", description: "Answers garbage", input: JobSearch, output: JobList })
export class BrokenJobsTool implements ToolHandler<JobSearch, JobList> {
  run(): Promise<JobList> {
    return Promise.resolve({ jobs: "x" } as JobList);
  }
}

// ── judges ──

@Judge({ name: "grounded-judge", model: "typesafe/jev-1.13", deps: [JudgeModel] })
export class GroundedJudge implements JudgeHandler {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply, task }: JudgeInput): Promise<JudgeVerdict> {
    const answers = await this.judgeModel.decide({
      state: { task, reply },
      questions: { grounded: Decision.noul("Is every claim of the reply grounded in the task?") },
    });
    const passed = answers.grounded.noul > 0.5;
    return passed ? { passed } : { passed, feedback: "cite the source of every claim" };
  }
}

@Judge({ name: "tone-judge", model: "moonshotai/kimi-k2.6", deps: [JudgeModel] })
export class ToneJudge implements JudgeHandler {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply }: JudgeInput): Promise<JudgeVerdict> {
    const said = await this.judgeModel.invoke(`Is this polite? Answer PASS or FAIL.\n${reply}`);
    return { passed: said.trim() === "PASS" };
  }
}

// ── a knowledge base ──

@Rag({ name: "handbook", description: "The team handbook", topK: 2, deps: [JobBoardService] })
export class HandbookRag implements RagConnector {
  constructor(private readonly jobBoardService: JobBoardService) {}

  async retrieve(
    query: string,
    options: { readonly topK: number; readonly signal: AbortSignal },
  ): Promise<RagRetrieval> {
    const found = await this.jobBoardService.search(query);
    const results = found.slice(0, options.topK).map((text, index) => ({
      source: `handbook#${String(index + 1)}`,
      text,
    }));
    return { results, costUsd: 0.001 };
  }
}

// ── a guardrail ──

/** Refunds over the environment's limit are blocked; others go through with a note. */
@Guardrail({ name: "refund-limit-guardrail", deps: [ApplicationContext, ExecutionContext] })
export class RefundLimitGuardrail implements Guardrail {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
  ) {}

  beforeToolCall(context: GuardrailContext): Promise<{ overrideArguments: { note: string } }> {
    const { amount } = (context.call as { args: { amount: number } }).args;
    const { environmentName } = this.applicationContext;
    if (amount > 100) return Promise.reject(new Error(`${String(amount)} is over the limit`));
    const note = `${environmentName}:${this.executionContext.step.nodeId}`;
    return Promise.resolve({ overrideArguments: { note } });
  }
}

// ── PII policies ──

@PiiPolicy({
  name: "contact-pii-policy",
  description: "Hides contact details",
  rules: [
    pii(PiiKind.Email, PiiAction.replaceWithToken()),
    pii(PiiKind.Phone, PiiAction.replacePart({ keepLast: 2 })),
  ],
})
export class ContactPiiPolicy {}

@PiiPolicy({
  name: "card-pii-policy",
  description: "Refuses card numbers",
  rules: [pii(PiiKind.CardNumber, PiiAction.blockWithRefusal({ refusal: "No cards here." }))],
})
export class CardPiiPolicy {}

@PiiPolicy({
  name: "name-pii-policy",
  description: "Finds people's names with a model",
  rules: [pii(PiiKind.PersonName, PiiAction.replaceWithKind())],
  detectWithModel: "moonshotai/kimi-k2.6",
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
  action: PiiAction.replaceWithToken(),
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

/** A name without the kind suffix: `[name.kind-suffix]`. */
@PiiPolicy({
  name: "contact-policy",
  description: "Misnamed",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithKind())],
})
export class MisnamedPolicy {}

// ── the project's context levels ──

export class ShopTenantContext extends TenantContext {
  @OneOf({ values: ["free", "pro"] })
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
  name: "plan_report",
  description: "Says the caller's plan",
  input: JobSearch,
  output: PlanReport,
  deps: [ShopTenantContext, ShopExecutionContext],
})
export class PlanReportTool implements ToolHandler<JobSearch, PlanReport> {
  constructor(
    private readonly shopTenantContext: ShopTenantContext,
    private readonly shopExecutionContext: ShopExecutionContext,
  ) {}

  run(): Promise<PlanReport> {
    const { tenantId, plan } = this.shopTenantContext;
    const { userId } = this.shopExecutionContext;
    return Promise.resolve({ summary: `${userId}@${tenantId}: ${plan}` });
  }
}
