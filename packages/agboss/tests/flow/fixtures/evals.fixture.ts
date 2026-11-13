// `agboss eval run` / `agboss check` fixture (#396 PR 2): a desk whose one agent looks an order up
// through a transport model provider that answers by the request — no network, no key — and two
// eval suites next to it (eval-suites/), one of them broken for `agboss check`.
import {
  Agent,
  Application,
  DecidedBy,
  EmptyEnvironment,
  Judge,
  JudgeVerdict,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  toolCallsOf,
  ToolCallStatus,
  type JudgeHandler,
  type JudgeInput,
  type ToolHandler,
} from "../../../src/index.js";
import { Text, WorkflowFinishTextDto } from "../../../src/dto/index.js";
import {
  ModelCost,
  ModelProvider,
  ModelProviderMessageRole,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderRequest,
  type ModelProviderResponse,
} from "../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { start } from "./paths.js";

/** A question to the desk (its own DTO: the fixture's module exports every class it uses). */
export class AskDto {
  @Text({ prompt: "the question" })
  text!: string;
}

export class OrderLookupDto {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

export class OrderStatusDto {
  @Text()
  status!: string;
}

@Tool({
  name: "lookup-tool",
  description: "An order's status",
  input: OrderLookupDto,
  output: OrderStatusDto,
})
export class LookupTool implements ToolHandler<OrderLookupDto, OrderStatusDto> {
  run({ orderId }: OrderLookupDto): Promise<OrderStatusDto> {
    return Promise.resolve({ status: `order ${orderId} shipped` });
  }
}

/** Looks the order up first, then answers with what the tool said. */
@ModelProvider({
  name: "scripted-model-provider",
  description: "Answers by the request: a lookup, then the tool's result",
  serves: [/^cli\//],
  timeout: seconds(5),
  cost: ModelCost.fromPrices({ "cli/desk": { inputPerMillion: usd(1), outputPerMillion: usd(1) } }),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class ScriptedModelProvider implements ModelProviderHandler {
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const result = request.messages.find(
      (message) => message.role === ModelProviderMessageRole.Tool,
    );
    const usage = { inputTokens: 1000, outputTokens: 100 };
    if (result === undefined)
      return Promise.resolve({
        text: "",
        toolCalls: [{ id: "call-1", name: "lookup-tool", arguments: { orderId: "7" } }],
        usage,
      });
    return Promise.resolve({ text: `It says: ${result.text}`, usage });
  }
}

@Agent({
  name: "lookup-agent",
  description: "Looks orders up",
  prompt: "Look the order up.",
  model: "cli/desk",
  input: { message: AskDto },
  tools: [LookupTool],
})
export class LookupAgent {}

@WorkflowStart({
  name: "ask-workflow-start",
  description: "A question",
  input: AskDto,
})
export class AskWorkflowStart {}

@WorkflowFinish({
  name: "answer-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class AnswerWorkflowFinish {}

@Workflow({
  name: "lookup-workflow",
  version: "1.0.0",
  flow: [
    start(AskWorkflowStart)
      .returns(AskDto)
      .toAgent(LookupAgent)
      .toFinish(AnswerWorkflowFinish),
  ],
})
export class LookupWorkflow {}

/** A code judge: one lookup, and the answer says what it found. */
@Judge({
  name: "quotes-lookup-judge",
  description: "The answer quotes the lookup",
  decidedBy: DecidedBy.Code,
  reply: WorkflowFinishTextDto,
})
export class QuotesLookupJudge implements JudgeHandler<WorkflowFinishTextDto> {
  judge({ reply, toolCalls }: JudgeInput<WorkflowFinishTextDto>): Promise<JudgeVerdict> {
    const [lookup] = toolCallsOf(LookupTool, toolCalls);
    const status = lookup?.status === ToolCallStatus.Succeeded ? lookup.output.status : "";
    return Promise.resolve(
      status !== "" && reply.text.includes(status)
        ? JudgeVerdict.passed()
        : JudgeVerdict.failed({ reason: "the answer does not quote the lookup" }),
    );
  }
}

@Application({
  name: "evals-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LookupWorkflow],
  budgets: TEST_BUDGETS,
  providers: [ScriptedModelProvider],
})
export class EvalsApplication {}
