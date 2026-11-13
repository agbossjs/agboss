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
} from "../../../src/index.js";
import {
  PlainTextDto,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { start } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { DEFAULTS, Grounded, MODEL_PROVIDERS, RUBRIC } from "./judged.workflow.js";

/**
 * #396 — code judges: `@Judge({ decidedBy: DecidedBy.Code })` decides by its `judge(input)` alone,
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
  decidedBy: DecidedBy.Code,
  reply: PlainTextDto,
  deps: [BannedWords, ExecutionContext],
})
export class NoBannedWordsJudge implements JudgeHandler<PlainTextDto> {
  constructor(
    private readonly bannedWords: BannedWords,
    private readonly executionContext: ExecutionContext,
  ) {}

  judge({ reply }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const { tenantId } = this.executionContext.tenant;
    const found = this.bannedWords.words.filter((word) => reply.text.includes(word));
    return Promise.resolve(
      found.length === 0
        ? JudgeVerdict.passed({ metrics: { words: reply.text.split(" ").length, tenantId } })
        : JudgeVerdict.failed({ reason: `never say ${found.join(", ")}` }),
    );
  }
}

@Agent({
  name: "promise-agent",
  prompt: "Write.",
  description: "Writes an answer, gated by code and by a model",
  model: "local/llama",
  judges: [NoBannedWordsJudge, Grounded],
  maxRetries: 1,
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
  flow: [
    start(PromiseStart)
      .returns(WorkflowStartTextDto)
      .toAgent(PromiseAgent)
      .toFinish(PromiseFinish),
  ],
  defaults: DEFAULTS,
  uncompactedTurns: 4,
  providers: [BannedWords, provide(RUBRIC, "Is the reply grounded? Answer PASS or FAIL: <why>.")],
})
export class PromiseDesk {}

@Application({
  name: "promise-desk-application",
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
  decidedBy: DecidedBy.Code,
  reply: PlainTextDto,
  deps: [SecondOpinion],
})
export class SecondOpinionJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly secondOpinion: SecondOpinion) {}

  async judge({ reply }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const tries = await Promise.allSettled([
      this.secondOpinion.ask(reply.text),
      this.secondOpinion.decide(),
      Promise.resolve()
        .then(() => this.secondOpinion.model()),
    ]);
    const outcomes = tries.map((tried) =>
      tried.status === "rejected" && tried.reason instanceof Error
        ? tried.reason.message
        : "answered",
    );
    return JudgeVerdict.failed({ reason: outcomes.join(" | ") });
  }
}
