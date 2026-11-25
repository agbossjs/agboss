import { Window4Memory } from "../../helpers/window-memory.js";
import {
  Agent,
  DecidedBy,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  Judge,
  JudgeModel,
  JudgeVerdict,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  provide,
  type JudgeHandler,
  type JudgeInput,
  inline,
  Ttl,
} from "../../../src/index.js";
import {
  PlainTextDto,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { onStart } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { DEFAULTS, Grounded, MODEL_PROVIDERS, RUBRIC } from "./judged.workflow.js";
import { LocalModelProvider } from "../../models/providers.fixture.js";

/**
 * #396 — code judges: `@Judge({ })` decides by its `judge(input)` alone,
 * with its services and the execution through `deps`; no model, no spend. Beside a model judge on one
 * agent, and two judges assembly refuses.
 */

/** The words the desk never says. */
@Injectable()
export class BannedWords {
  readonly words: readonly string[] = ["guarantee"];
}

/** Rejects a reply with a banned word; reads the execution it judges in. */
@Judge({
  name: "no-banned-words-judge",
  description: "The reply says no banned word",
  output: PlainTextDto,
  deps: [BannedWords, ExecutionContext],
})
export class NoBannedWordsJudge implements JudgeHandler<PlainTextDto> {
  constructor(
    private readonly bannedWords: BannedWords,
    private readonly executionContext: ExecutionContext,
  ) {}

  /** Sync: a code judge returns its verdict, no `Promise.resolve`. */
  judge({ output }: JudgeInput<PlainTextDto>): JudgeVerdict {
    const { tenantId } = this.executionContext.tenant;
    const found = this.bannedWords.words.filter((word) => output.text.includes(word));
    return found.length === 0
      ? JudgeVerdict.passed({ metrics: { words: output.text.split(" ").length, tenantId } })
      : JudgeVerdict.failed(`never say ${found.join(", ")}`);
  }
}

@Agent({
  name: "promise-agent",
  prompt: inline("Write."),
  description: "Writes an answer, gated by code and by a model",
  model: "local/llama",
  judges: [NoBannedWordsJudge, Grounded],
  executionLimits: { maxRetries: 1 },
})
export class PromiseAgent {}

@WorkflowStart({
  name: "promise-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
export class PromiseStart {}

@WorkflowFinish({
  name: "promise-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class PromiseFinish {}

@Workflow({
  name: "promise-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(PromiseStart).toAgent(PromiseAgent).toFinish(PromiseFinish)],
  defaults: DEFAULTS,
  memory: Window4Memory,
  providers: [BannedWords, provide(RUBRIC, "Is the reply grounded? Answer PASS or FAIL: <why>.")],
})
export class PromiseDesk {}

@Application({
  name: "promise-desk-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PromiseDesk],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class PromiseDeskApplication {}

/** A service that asks the judge's model: a code judge that uses it has none. */
@Injectable({ deps: [JudgeModel] })
export class SecondOpinion {
  constructor(private readonly judgeModel: JudgeModel) {}

  ask(text: string): Promise<string> {
    return this.judgeModel.invoke(`Is "${text}" fine?`);
  }

  decide(): Promise<unknown> {
    return this.judgeModel.decide({ state: "s", questions: {} });
  }

  model(): string {
    return this.judgeModel.model;
  }
}

/** A code judge that reaches for a model through a service. */
@Judge({
  name: "second-opinion-judge",
  output: PlainTextDto,
  deps: [SecondOpinion],
})
export class SecondOpinionJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly secondOpinion: SecondOpinion) {}

  async judge({ output }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const tries = await Promise.allSettled([
      this.secondOpinion.ask(output.text),
      this.secondOpinion.decide(),
      Promise.resolve().then(() => this.secondOpinion.model()),
    ]);
    const outcomes = tries.map((tried) =>
      tried.status === "rejected" && tried.reason instanceof Error
        ? tried.reason.message
        : "answered",
    );
    return JudgeVerdict.failed(outcomes.join(" | "));
  }
}
