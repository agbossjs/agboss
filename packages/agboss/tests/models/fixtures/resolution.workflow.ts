import {
  Agent,
  Compaction,
  CompactionStrategy,
  DecidedBy,
  EmptyEnvironment,
  Injectable,
  Judge,
  TokenLimit,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  JudgeVerdict,
  type JudgeHandler,
} from "../../../src/index.js";
import { PromptInjectionGuardrail } from "../../fixtures/guardrails.js";
import {
  PlainTextDto,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { route, start } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { DecisionsModelProvider } from "../../../src/models/index.js";
import { LocalMirrorModelProvider, LocalModelProvider } from "../providers.fixture.js";

/**
 * #266: every model of an application resolves to exactly one of its model providers by `serves` —
 * every kind of model use (agents, model routers, the default router, guards, compaction, judges).
 */

@Judge({ name: "nowhere-judge", model: "nowhere/judge", reply: PlainTextDto })
export class NowhereJudge implements JudgeHandler<PlainTextDto> {
  judge(): Promise<JudgeVerdict> {
    return Promise.resolve(JudgeVerdict.passed());
  }
}

@Agent({
  name: "nowhere-agent",
  prompt: "Answer.",
  description: "Answers on a model no listed provider serves",
  model: "nowhere/agent",
  judges: [NowhereJudge],
})
export class NowhereAgent {}

@Agent({
  name: "local-agent",
  prompt: "Answer.",
  description: "Answers on the local server",
  model: "local/llama",
})
export class LocalAgent {}

@WorkflowStart({
  name: "resolution-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class ResolutionStart {}

@WorkflowFinish({
  name: "resolution-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class ResolutionFinish {}

@Router({
  name: "nowhere-router",
  description: "Picks the agent, on a chat model no listed provider serves",
  decidedBy: DecidedBy.Model,
  prompt: "Pick who answers.",
  model: "nowhere/router",
  input: { message: WorkflowStartTextDto },
  routes: [{ prompt: "Anything", target: NowhereAgent }],
})
export class NowhereRouter {}

/** A compaction on a model no listed provider serves (#120 PR 3). */
@Compaction({
  name: "nowhere-compaction",
  description: "Summarises on a model nobody serves",
  model: "nowhere/compaction",
  strategy: CompactionStrategy.SummaryQueue,
  turnsBetweenCompactions: 2,
  summaryQueueLength: 1,
  summaryMaxTokens: 200,
})
export class NowhereCompaction {}

/** Every kind of model use, none served by the local providers. */
@Workflow({
  name: "every-kind-workflow",
  version: "1.0.0",
  flow: [
    start(ResolutionStart)
      .returns(WorkflowStartTextDto)
      .toRouter(NowhereRouter)
      .chooseOne(
        route(NowhereAgent)
          .toFinish(ResolutionFinish),
      ),
  ],
  defaults: {
    models: { temperature: 0, maxTokens: TokenLimit.MODEL_MAX },
    router: { model: "nowhere/default-router" },
    guardrail: { model: "nowhere/guardrail" },
  },
  uncompactedTurns: 1,
  guardrails: [PromptInjectionGuardrail],
  compaction: NowhereCompaction,
})
export class EveryKindWorkflow {}

/** Only the local server is listed: the built-ins are not added next to it. */
@Application({
  name: "every-kind-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EveryKindWorkflow],
  providers: [LocalModelProvider],
  budgets: TEST_BUDGETS,
})
export class EveryKindApplication {}

@WorkflowStart({
  name: "local-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class LocalStart {}

/** One agent on `local/llama` and a Jev router default: what a local application serves. */
@Workflow({
  name: "local-workflow",
  version: "1.0.0",
  flow: [
    start(LocalStart)
      .returns(WorkflowStartTextDto)
      .toAgent(LocalAgent)
      .toFinish(ResolutionFinish),
  ],
  defaults: {
    models: { temperature: 0, maxTokens: TokenLimit.MODEL_MAX },
    router: { model: "typesafe/jev-1.13" },
  },
  uncompactedTurns: 1,
})
export class LocalWorkflow {}

/** The local server and its mirror both serve `local/llama`: neither wins. */
@Application({
  name: "mirrored-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LocalWorkflow],
  providers: [LocalModelProvider, LocalMirrorModelProvider, DecisionsModelProvider],
  budgets: TEST_BUDGETS,
})
export class MirroredApplication {}

/** Lists no model provider: the built-in OpenRouter (chat) and Decisions (Jev) serve it. */
@Application({
  name: "built-in-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LocalWorkflow],
  budgets: TEST_BUDGETS,
})
export class BuiltInApplication {}

/** Lists only the local server: Jev's default router has no provider — the list is complete. */
@Application({
  name: "local-only-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LocalWorkflow],
  providers: [LocalModelProvider],
  budgets: TEST_BUDGETS,
})
export class LocalOnlyApplication {}

@Injectable()
export class NotInfrastructure {}

/** A model provider in a workflow's providers: infrastructure is the application's. */
@Workflow({
  name: "misplaced-provider-workflow",
  version: "1.0.0",
  flow: [
    start(LocalStart)
      .returns(WorkflowStartTextDto)
      .toAgent(LocalAgent)
      .toFinish(ResolutionFinish),
  ],
  defaults: {
    models: { temperature: 0, maxTokens: TokenLimit.MODEL_MAX },
    router: { model: "typesafe/jev-1.13" },
  },
  uncompactedTurns: 1,
  providers: [NotInfrastructure, LocalModelProvider],
})
export class MisplacedProviderWorkflow {}

@Application({
  name: "misplaced-provider-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MisplacedProviderWorkflow],
  budgets: TEST_BUDGETS,
})
export class MisplacedProviderApplication {}
