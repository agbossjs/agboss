import {
  Agent,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type InferEnv,
  inline,
  Ttl,
} from "../../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { Application } from "../../../../src/application/application.js";
import { ModelProvider, OpenAiCompatibleDriver } from "../../../../src/models/index.js";
import { seconds } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { onStart } from "../../../helpers/flow.js";
import { appEnv } from "./app.env.js";

/** The application's models: roles `default` and `fast`. */
@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://models.test/v1" }),
  models: { default: "base/default", fast: "base/fast" },
  timeout: seconds(5),
})
export class ConfigModels {}

/** The provider a profile swaps in. */
@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://other.test/v1" }),
  models: { default: "other/default", fast: "other/fast" },
  timeout: seconds(5),
})
export class OtherModels {}

@Agent({
  name: "ts-agent",
  prompt: inline("Answer."),
  description: "Answers on its role's model",
  model: "fast",
})
export class TsAgent {}

@WorkflowStart({
  name: "ts-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
class TsStart {}

@WorkflowFinish({
  name: "ts-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
class TsFinish {}

@Workflow({
  name: "ts-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(TsStart).toAgent(TsAgent).toFinish(TsFinish)],
})
export class TsWorkflow {}

/** Reads `appEnv`: what `configureEnv` in a profile changes. */
@Injectable({ deps: [appEnv] })
export class RegionService {
  constructor(readonly config: InferEnv<typeof appEnv>) {}
}

@Application({
  name: "ts-application",
  version: "1.0.0",
  workflows: [TsWorkflow],
  budgets: TEST_BUDGETS,
  modelProvider: ConfigModels,
  providers: [ConfigModels, OtherModels, RegionService],
})
export class TsApplication {}
