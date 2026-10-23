import {
  Agent,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type OnInit,
  type OnStart,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import type { Class } from "../../../src/components/injection.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import {
  ModelCost,
  ModelProvider,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderRequest,
  type ModelProviderResponse,
} from "../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";

/** #439: an application whose only model provider is a transport — what a VCR test records from. */

/** What the transport's hooks and calls did, in order: one log per application instance. */
@Injectable()
export class EchoLog {
  readonly entries: string[] = [];
}

@ModelProvider({
  name: "echo-model-provider",
  description: "Answers by the request, offline",
  serves: [/^echo\//],
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "echo/first": { inputPerMillion: usd(1), outputPerMillion: usd(1) },
    "echo/second": { inputPerMillion: usd(1), outputPerMillion: usd(1) },
  }),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
  deps: [EchoLog],
})
export class EchoModelProvider implements ModelProviderHandler, OnInit, OnStart {
  constructor(private readonly echoLog: EchoLog) {}

  onInit(): void {
    this.echoLog.entries.push("onInit");
  }

  onStart(): void {
    this.echoLog.entries.push("onStart");
  }

  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.echoLog.entries.push(`complete ${request.model}`);
    return Promise.resolve({
      text: `answered by ${request.model}`,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }
}

/** One text workflow on `model`: its start, its agent and its finish. */
function echoWorkflowOn(
  model: string,
  prefix: string,
): { workflow: Class; start: Class; agent: Class } {
  @WorkflowStart({
    name: `${prefix}-workflow-start`,
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class EchoStart {}

  @WorkflowFinish({
    name: `${prefix}-workflow-finish`,
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class EchoFinish {}

  @Agent({ name: `${prefix}-agent`, description: "Echoes", prompt: "Repeat the message.", model })
  class EchoAgent {}

  @Workflow({
    name: `${prefix}-workflow`,
    version: "1.0.0",
    flow: [start(EchoStart).returns(WorkflowStartTextDto).toAgent(EchoAgent).toFinish(EchoFinish)],
  })
  class EchoWorkflow {}

  return { workflow: EchoWorkflow, start: EchoStart, agent: EchoAgent };
}

export const FIRST = echoWorkflowOn("echo/first", "first-echo");
export const SECOND = echoWorkflowOn("echo/second", "second-echo");

@Application({
  name: "echo-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FIRST.workflow, SECOND.workflow],
  providers: [EchoModelProvider, EchoLog],
  budgets: TEST_BUDGETS,
})
export class EchoApplication {}
