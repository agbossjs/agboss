import { Window1Memory } from "../../helpers/window-memory.js";
import {
  Agent,
  EmptyEnvironment,
  TokenLimit,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
} from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import {
  ModelProvider,
  OpenAiCompatibleDriver,
  RetryPolicy,
  type ModelCost,
} from "../../../src/models/index.js";
import { minutes, seconds, usd, days } from "../../../src/units/index.js";
import { onStart } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { CircuitBreakerPolicy } from "../../../src/models/circuit-breaker-policy.js";

/** A price table with a negative price: a literal, since `ModelCost.fromPrices` refuses it. */
const wrongPrices: ModelCost = {
  kind: "from-prices",
  prices: {
    "vendor/big": { inputPerMillion: usd(1), outputPerMillion: -1 as ReturnType<typeof usd> },
  },
};
const breaker = CircuitBreakerPolicy.fixed({
  failureThreshold: 3,
  failureWindow: minutes(1),
  openDuration: seconds(30),
});

/** A provider that breaks two rules: a price below 0 and a timeout above the maximum. */
@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://bad.test/v1" }),
  model: "vendor/big",
  timeout: days(2),
  cost: wrongPrices,
  circuitBreakerPolicy: breaker,
})
export class BrokenModels {}

/** The same rules, kept. */
@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://ok.test/v1" }),
  model: "vendor/big",
  timeout: seconds(5),
  cost: { kind: "from-response" },
  circuitBreakerPolicy: breaker,
})
export class SoundModels {}

@Agent({ name: "sound-agent", prompt: inline("Answer."), description: "Answers" })
export class SoundAgent {}

@Agent({
  name: "broken-agent",
  prompt: inline("Answer."),
  description: "Names the broken provider itself",
  modelProvider: BrokenModels,
})
export class BrokenAgent {}

@WorkflowStart({
  name: "sound-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class SoundStart {}

@WorkflowFinish({
  name: "sound-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class SoundFinish {}

@WorkflowStart({
  name: "broken-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class BrokenStart {}

@WorkflowFinish({
  name: "broken-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class BrokenFinish {}

const defaults = { models: { temperature: 0, maxTokens: TokenLimit.ModelMax } };

/** Names no provider itself: it inherits its application's. */
@Workflow({
  name: "sound-workflow",
  version: "1.0.0",
  flow: [onStart(SoundStart).toAgent(SoundAgent).toFinish(SoundFinish)],
  defaults,
  memory: Window1Memory,
})
export class SoundWorkflow {}

/** The workflow alone names the broken provider. */
@Workflow({
  name: "broken-workflow",
  version: "1.0.0",
  flow: [onStart(BrokenStart).toAgent(SoundAgent).toFinish(BrokenFinish)],
  defaults,
  memory: Window1Memory,
  modelProvider: BrokenModels,
})
export class BrokenWorkflow {}

@Workflow({
  name: "broken-agent-workflow",
  version: "1.0.0",
  flow: [onStart(BrokenStart).toAgent(BrokenAgent).toFinish(BrokenFinish)],
  defaults,
  memory: Window1Memory,
  modelProvider: SoundModels,
})
export class BrokenAgentWorkflow {}

/** The application names the broken provider; it lists none. */
@Application({
  name: "broken-app-level-applicationlication",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SoundWorkflow],
  modelProvider: BrokenModels,
  budgets: TEST_BUDGETS,
})
export class BrokenAppLevelApplication {}

/** Only the workflow names the broken provider. */
@Application({
  name: "broken-workflow-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BrokenWorkflow],
  modelProvider: SoundModels,
  budgets: TEST_BUDGETS,
})
export class BrokenWorkflowApplication {}

/** Only the agent names the broken provider. */
@Application({
  name: "broken-agent-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BrokenAgentWorkflow],
  budgets: TEST_BUDGETS,
})
export class BrokenAgentApplication {}

/** The same shapes with sound providers only. */
@Application({
  name: "sound-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SoundWorkflow],
  modelProvider: SoundModels,
  budgets: TEST_BUDGETS,
})
export class SoundApplication {}

/** A second and a third sound provider, named by a workflow and by an agent only. */
@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://second.test/v1" }),
  model: "vendor/second",
  timeout: seconds(5),
  cost: { kind: "from-response" },
  circuitBreakerPolicy: breaker,
})
export class SecondModels {}

@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://third.test/v1" }),
  model: "vendor/third",
  timeout: seconds(5),
  cost: { kind: "from-response" },
  circuitBreakerPolicy: breaker,
})
export class ThirdModels {}

@Agent({
  name: "third-agent",
  prompt: inline("Answer."),
  description: "Names the third provider",
  modelProvider: ThirdModels,
})
export class ThirdAgent {}

@Workflow({
  name: "named-workflow",
  version: "1.0.0",
  flow: [onStart(SoundStart).toAgent(ThirdAgent).toFinish(SoundFinish)],
  defaults,
  memory: Window1Memory,
  modelProvider: SecondModels,
})
export class NamedWorkflow {}

/** Three levels name three providers; none is listed in `providers`. */
@Application({
  name: "named-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [NamedWorkflow],
  modelProvider: SoundModels,
  budgets: TEST_BUDGETS,
})
export class NamedApplication {}
