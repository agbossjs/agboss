import {
  Agent,
  InjectionToken,
  Judge,
  provide,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  MODEL_MAX,
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
import { DecisionsModelProvider } from "../../../src/models/index.js";
import { LocalModelProvider } from "../../models/providers.fixture.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** What the judge asks its model (a provider value: the judge gets it through its `deps`). */
export const RUBRIC = new InjectionToken<string>("RUBRIC");

/** Asks its own model whether the reply is grounded: `PASS`, or `FAIL: <why>`. */
@Judge({
  name: "grounded",
  model: "local/judge",
  reply: PlainTextDto,
  deps: [RUBRIC, JudgeModel],
})
export class Grounded implements JudgeHandler<PlainTextDto> {
  constructor(
    private readonly rubric: string,
    private readonly judgeModel: JudgeModel,
  ) {}

  async judge({ reply, task }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const verdict = await this.judgeModel.invoke(
      `${this.rubric}\n\nTask: ${task}\nReply: ${reply.text}`,
    );
    return verdict.startsWith("PASS")
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed({ reason: verdict.replace(/^FAIL:\s*/u, "") });
  }
}

@Agent({
  name: "writer-agent",
  prompt: "Write.",
  description: "Writes an answer",
  model: "local/llama",
  judges: [Grounded],
  maxRetries: 1,
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
  models: { temperature: 0, maxTokens: MODEL_MAX },
  router: { model: "typesafe/jev-1.13" },
} as const;

/** The judged applications' model providers (#266): Jev's decisions, the local chat models. */
export const MODEL_PROVIDERS = [DecisionsModelProvider, LocalModelProvider];

/** One agent gated by one judge, one retry. */
@Workflow({
  name: "judged-desk-workflow",
  version: "1.0.0",
  flow: [
    start(TaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Writer)
      .toFinish(Reply),
  ],
  defaults: DEFAULTS,
  uncompactedTurns: 4,
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
@Judge({ name: "modelless", model: "", reply: PlainTextDto })
export class Modelless implements JudgeHandler<PlainTextDto> {
  judge(): Promise<JudgeVerdict> {
    return Promise.resolve(JudgeVerdict.passed());
  }
}

@Agent({
  name: "careless-agent",
  prompt: "Write.",
  description: "Gated by a judge without a model",
  model: "local/llama",
  judges: [Modelless],
})
export class Careless {}

@Workflow({
  name: "modelless-desk-workflow",
  version: "1.0.0",
  flow: [
    start(TaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Careless)
      .toFinish(Reply),
  ],
  defaults: DEFAULTS,
  uncompactedTurns: 4,
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
