import {
  Action,
  Agent,
  Arbiter,
  DecidedBy,
  EmptyEnvironment,
  InputGuardrail,
  PiiAction,
  PiiKind,
  PiiPolicy,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type Class,
  type Tracked,
  inline,
} from "../../../src/index.js";
import { Text } from "../../../src/dto/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { ModelCost, ModelProvider, OpenAiCompatibleDriver } from "../../../src/models/index.js";
import { seconds, usd } from "../../../src/units/index.js";
import { onStart, toAgent, toFinish } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";

export class AnswerDto {
  @Text({ prompt: "an answer" })
  answer!: string;
}

/** The application's provider: roles `fast` and `big`, a `default`. */
@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://alpha.test/v1" }),
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  models: { default: "alpha/mid", fast: "alpha/small", big: "alpha/large" },
})
export class AlphaModels {}

/** A second provider: one `model`, and no price (unpriced). */
@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://beta.test/v1" }),
  timeout: seconds(5),
  model: "beta/only",
})
export class BetaModels {}

/** A provider whose price table is wrong: the provider rules must reach it through a component. */
@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://bad.test/v1" }),
  timeout: seconds(5),
  model: "bad/big",
  cost: {
    kind: "from-prices",
    prices: {
      "bad/big": { inputPerMillion: usd(1), outputPerMillion: -1 as ReturnType<typeof usd> },
    },
  },
})
export class BadPricedModels {}

/** What the components of one workflow name themselves. */
export interface ComponentLevels {
  /** `@Application({ modelProvider })`. */
  readonly appProvider: Class;
  /** `@Application({ defaults: { models: { model } } })`. */
  readonly appModel?: string;
  readonly workflowProvider?: Class;
  readonly workflowModel?: string;
  /** The `modelProvider` of the router, the guardrail, the PII policy and the agent. */
  readonly componentProvider?: Class;
  /** The agent names `model: "default"` instead of nothing. */
  readonly agentNamesDefault?: boolean;
}

/** A workflow whose router, agents, guardrail and PII detection name no model, on the given levels. */
export function componentsApplication(levels: ComponentLevels): Class {
  const { componentProvider } = levels;
  const own = componentProvider === undefined ? {} : { modelProvider: componentProvider };

  @WorkflowStart({
    name: "lv-workflow-start",
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class LvStart {}

  @InputGuardrail({
    name: "lv-input-guardrail",
    description: "Names no model",
    prompt: inline("Is it rude?"),
    threshold: 0.5,
    refusal: "Be polite.",
    ...own,
  })
  class LvGuardrail {}

  @PiiPolicy({
    name: "lv-pii-policy",
    description: "Finds names with a model",
    rules: [PiiKind.Email.mask()],
    model: "detector/names",
    ...own,
  })
  class LvPii {
    readonly action = PiiAction.block();
  }

  @Agent({
    name: "lv-agent",
    description: "Names no model",
    prompt: inline("Answer."),
    input: { message: WorkflowStartTextDto },
    output: AnswerDto,
    guardrails: [LvGuardrail],
    ...(levels.agentNamesDefault === true ? { model: "default" } : {}),
    ...own,
  })
  class LvAgent {}

  @WorkflowFinish({ name: "lv-workflow-finish", description: "The answer", output: AnswerDto })
  class LvFinish {}

  @WorkflowFinish({
    name: "lv-stop-workflow-finish",
    description: "Stopped",
    output: WorkflowStartTextDto,
  })
  class LvStop {}

  @Router({
    name: "lv-router",
    description: "Names no model",
    decidedBy: DecidedBy.Model,
    prompt: inline("Pick."),
    input: { message: WorkflowStartTextDto },
    routes: [
      { target: LvAgent, prompt: "Answer it" },
      { target: LvStop, prompt: "Stop" },
    ],
    ...own,
  })
  class LvRouter {}

  @Workflow({
    name: "lv-workflow",
    version: "1.0.0",
    flow: [
      onStart(LvStart)
        .toRouter(LvRouter)
        .onRoute(
          toAgent(LvAgent)
            .toFinish(LvFinish),
        )
        .onRoute(toFinish(LvStop)),
    ],
    piiPolicies: [LvPii],
    ...(levels.workflowProvider === undefined ? {} : { modelProvider: levels.workflowProvider }),
    ...(levels.workflowModel === undefined
      ? {}
      : { defaults: { models: { temperature: 0, model: levels.workflowModel } } }),
  })
  class LvWorkflow {}

  @Application({
    name: "lv-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [LvWorkflow],
    modelProvider: levels.appProvider,
    budgets: TEST_BUDGETS,
    ...(levels.appModel === undefined
      ? {}
      : { defaults: { models: { temperature: 0, model: levels.appModel } } }),
  })
  class LvApplication {}
  return LvApplication;
}

/** A model arbiter that names no model, accepting two copies of an agent. */
export function arbiterApplication(modelProvider?: Class): Class {
  @WorkflowStart({
    name: "arb-workflow-start",
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class ArbStart {}

  @Agent({
    name: "arb-agent",
    description: "Answers",
    prompt: inline("Answer."),
    input: { message: WorkflowStartTextDto },
    output: AnswerDto,
    model: "alpha/small",
  })
  class ArbAgent {}

  @Action({
    name: "arb-finish-action",
    description: "Counts",
    input: { answers: listOf(AnswerDto) },
    output: WorkflowFinishTextDto,
  })
  class ArbAction {
    async execute(i: { readonly answers: readonly Tracked<AnswerDto>[] }) {
      return { text: String(i.answers.length) };
    }
  }

  @Arbiter({
    name: "arb-arbiter",
    prompt: inline("Count it."),
    criteria: [{ target: ArbAgent, prompt: "ok" }],
    ...(modelProvider === undefined ? {} : { modelProvider }),
  })
  class ArbArbiter {}

  @WorkflowFinish({
    name: "arb-workflow-finish",
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class ArbFinish {}

  @Workflow({
    name: "arb-workflow",
    version: "1.0.0",
    flow: [
      onStart(ArbStart)
        .inParallel([toAgent(ArbAgent), toAgent(ArbAgent)])
        .arbitratedBy(ArbArbiter)
        .joinQuorum({ min: 2 })
        .toAction(ArbAction)
        .toFinish(ArbFinish),
    ],
  })
  class ArbWorkflow {}

  @Application({
    name: "arb-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [ArbWorkflow],
    modelProvider: AlphaModels,
    budgets: TEST_BUDGETS,
  })
  class ArbApplication {}
  return ArbApplication;
}
