import {
  Agent,
  InjectionToken,
  Judge,
  provide,
  Workflow,
  WorkflowFinish,
  WorkflowSettings,
  WorkflowStart,
  type WorkflowDefinition,
  MODEL_MAX,
} from "../../../src/index.js";
import {
  JudgeModel,
  type JudgeHandler,
  type JudgeInput,
  type JudgeVerdict,
} from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { DecisionsModelProvider } from "../../../src/models/index.js";
import { LocalModelProvider } from "../../models/providers.fixture.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";

/** What the judge asks its model (a provider value: the judge gets it through its `deps`). */
export const RUBRIC = new InjectionToken<string>("RUBRIC");

/** Asks its own model whether the reply is grounded: `PASS`, or `FAIL: <why>`. */
@Judge({ name: "grounded", model: "local/judge", deps: [RUBRIC, JudgeModel] })
export class Grounded implements JudgeHandler {
  constructor(
    private readonly rubric: string,
    private readonly judgeModel: JudgeModel,
  ) {}

  async judge({ reply, task }: JudgeInput): Promise<JudgeVerdict> {
    const verdict = await this.judgeModel.invoke(
      `${this.rubric}\n\nTask: ${task}\nReply: ${reply}`,
    );
    return verdict.startsWith("PASS")
      ? { passed: true }
      : { passed: false, feedback: verdict.replace(/^FAIL:\s*/u, "") };
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
  history: { limit: 4 },
} as const;

export const settings = (): WorkflowSettings =>
  WorkflowSettings.builder()
    .modelProviders([DecisionsModelProvider, LocalModelProvider])
    .defaultModelProvider(LocalModelProvider)
    .build();

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
  providers: [provide(RUBRIC, "Is the reply grounded in the task? Answer PASS or FAIL: <why>.")],
})
export class JudgedDesk implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return settings();
  }
}

@Application({
  name: "judged-desk-application",
  version: "1.0.0",
  workflows: [JudgedDesk],
  budgets: TEST_BUDGETS,
})
export class JudgedDeskApplication {}

/** A judge with no model: assembly must refuse it. */
@Judge({ name: "modelless", model: "" })
export class Modelless implements JudgeHandler {
  judge(): Promise<JudgeVerdict> {
    return Promise.resolve({ passed: true });
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
})
export class ModellessDesk implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return settings();
  }
}

@Application({
  name: "modelless-desk-application",
  version: "1.0.0",
  workflows: [ModellessDesk],
  budgets: TEST_BUDGETS,
})
export class ModellessDeskApplication {}
