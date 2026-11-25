import { Window4Memory } from "../../helpers/window-memory.js";
import {
  Agent,
  InjectionToken,
  Judge,
  provide,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  TokenLimit,
  inline,
  Ttl,
} from "../../../src/index.js";
import {
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
} from "../../../src/index.js";
import {
  PlainTextDto,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../src/dto/index.js";
import {} from "../../../src/models/index.js";
import { LocalModelProvider, TestDecisionsProvider } from "../../models/providers.fixture.js";
import { onStart } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** What the judge asks its model (a provider value: the judge gets it through its `deps`). */
export const RUBRIC = new InjectionToken<string>("RUBRIC");

/** Asks its own model whether the reply is grounded: `PASS`, or `FAIL: <why>`. */
@Judge({
  name: "grounded",
  model: "local/judge",
  modelProvider: LocalModelProvider,
  output: PlainTextDto,
  deps: [RUBRIC, JudgeModel],
})
export class Grounded implements JudgeHandler<PlainTextDto> {
  constructor(
    private readonly rubric: string,
    private readonly judgeModel: JudgeModel,
  ) {}

  async judge({ output, task }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const verdict = await this.judgeModel.invoke(
      `${this.rubric}\n\nTask: ${task}\nReply: ${output.text}`,
    );
    return verdict.startsWith("PASS")
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed(verdict.replace(/^FAIL:\s*/u, ""));
  }
}

@Agent({
  name: "writer-agent",
  prompt: inline("Write."),
  description: "Writes an answer",
  model: "local/llama",
  modelProvider: LocalModelProvider,
  judges: [Grounded],
  executionLimits: { maxRetries: 1 },
})
export class Writer {}

@WorkflowStart({ name: "task-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class TaskStart {}

@WorkflowFinish({
  name: "reply-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class Reply {}

export const DEFAULTS = {
  models: { temperature: 0, maxTokens: TokenLimit.ModelMax },
} as const;

/** The judged applications' model providers (#266): Jev's decisions, the local chat models. */
export const MODEL_PROVIDERS = [TestDecisionsProvider, LocalModelProvider];

/** One agent gated by one judge, one retry. */
@Workflow({
  name: "judged-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(TaskStart)
    .toAgent(Writer)
    .toFinish(Reply)],
  defaults: DEFAULTS,
  memory: Window4Memory,
  providers: [provide(RUBRIC, "Is the reply grounded in the task? Answer PASS or FAIL: <why>.")],
})
export class JudgedDesk {}

@Application({
  name: "judged-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [JudgedDesk],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class JudgedDeskApplication {}

/** A judge with no model: assembly must refuse it. */
@Judge({ name: "modelless", model: "", output: PlainTextDto, deps: [JudgeModel] })
export class Modelless implements JudgeHandler<PlainTextDto> {
  judge(): Promise<JudgeVerdict> {
    return Promise.resolve(JudgeVerdict.passed());
  }
}

@Agent({
  name: "careless-agent",
  prompt: inline("Write."),
  description: "Gated by a judge without a model",
  model: "local/llama",
  modelProvider: LocalModelProvider,
  judges: [Modelless],
})
export class Careless {}

@Workflow({
  name: "modelless-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(TaskStart)
    .toAgent(Careless)
    .toFinish(Reply)],
  defaults: DEFAULTS,
  memory: Window4Memory,
})
export class ModellessDesk {}

@Application({
  name: "modelless-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ModellessDesk],
  budgets: TEST_BUDGETS,
})
export class ModellessDeskApplication {}
