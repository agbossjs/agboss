import {
  A2AAgent,
  A2ACallerResolution,
  A2AClient,
  A2AExpose,
  type A2ACallerResolver,
} from "../../../src/a2a/index.js";
import { Application } from "../../../src/application/application.js";
import { McpServer, McpTool } from "../../../src/components/decorators.js";
import { McpServerClient } from "../../../src/components/mcp-client.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  EmptyEnvironment,
  Injectable,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ToolHandler,
} from "../../../src/index.js";
import { McpExpose } from "../../../src/mcp/index.js";
import { usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";

/**
 * Declared contracts (#398 PR 3): a shop that exports two starts over A2A and one over MCP, and
 * consumes a billing desk over A2A (with a contract price) and a knowledge-base MCP server.
 */

export class InvoiceQuestionDto {
  @Text({ prompt: "the question about an invoice" })
  question!: string;
}

export class InvoiceAnswerDto {
  @Text()
  answer!: string;
}

@A2AAgent({
  name: "billing-desk-a2a-agent",
  url: "http://billing.invalid",
  target: { application: "billing-application", start: "billing-workflow-start" },
  input: InvoiceQuestionDto,
  output: InvoiceAnswerDto,
  price: usd(0.05),
})
export class BillingDeskA2AAgent extends A2AClient<InvoiceQuestionDto, InvoiceAnswerDto> {}

@Tool({
  name: "ask-billing-tool",
  description: "Asks the billing desk",
  input: InvoiceQuestionDto,
  output: InvoiceAnswerDto,
  deps: [BillingDeskA2AAgent],
})
export class AskBillingTool implements ToolHandler<InvoiceQuestionDto, InvoiceAnswerDto> {
  constructor(private readonly billingDeskA2AAgent: BillingDeskA2AAgent) {}

  run(question: InvoiceQuestionDto): Promise<InvoiceAnswerDto> {
    return this.billingDeskA2AAgent.execute(question);
  }
}

export class SearchQueryDto {
  @Text({ prompt: "what to search" })
  query!: string;
}

export class SearchHitDto {
  @Text()
  text!: string;
}

const kbTools = { search: { input: SearchQueryDto, output: SearchHitDto } };

@McpServer({
  name: "kb",
  transport: "stdio",
  command: "kb-server",
  target: { application: "kb-application", expose: "kb-mcp-expose" },
  tools: kbTools,
})
export class KbServer extends McpServerClient<typeof kbTools> {}

@McpTool({
  server: KbServer,
  name: "search-kb-tool",
  description: "Searches the knowledge base",
  input: SearchQueryDto,
  output: SearchHitDto,
  deps: [KbServer],
})
export class SearchKbTool implements ToolHandler<SearchQueryDto, SearchHitDto> {
  constructor(private readonly kbServer: KbServer) {}

  run(query: SearchQueryDto): Promise<SearchHitDto> {
    return this.kbServer.call("search", query);
  }
}

@Agent({
  name: "quote-desk-agent",
  description: "Answers quote questions",
  model: "test/quote",
  tools: [AskBillingTool],
})
export class QuoteDeskAgent {}

@Agent({
  name: "kb-desk-agent",
  description: "Answers from the knowledge base",
  model: "test/kb",
  tools: [SearchKbTool],
})
export class KbDeskAgent {}

@WorkflowStart({
  name: "quote-workflow-start",
  description: "A quote",
  input: WorkflowStartTextDto,
})
export class QuoteWorkflowStart {}

@WorkflowStart({
  name: "refund-workflow-start",
  description: "A refund",
  input: WorkflowStartTextDto,
})
export class RefundWorkflowStart {}

@WorkflowStart({ name: "kb-workflow-start", description: "A search", input: WorkflowStartTextDto })
export class KbWorkflowStart {}

@WorkflowFinish({
  name: "quote-workflow-finish",
  description: "The quote",
  output: WorkflowFinishTextDto,
})
export class QuoteWorkflowFinish {}

@WorkflowFinish({
  name: "refund-workflow-finish",
  description: "The refund, handed over",
  output: WorkflowStartTextDto,
})
export class RefundWorkflowFinish {}

@WorkflowFinish({
  name: "kb-workflow-finish",
  description: "The hit",
  output: WorkflowFinishTextDto,
})
export class KbWorkflowFinish {}

@Injectable()
export class OpenCallerResolver implements A2ACallerResolver<typeof QuoteWorkflowStart> {
  resolveCaller(): A2ACallerResolution<typeof QuoteWorkflowStart> {
    return A2ACallerResolution.resolved({});
  }
}

@Workflow({
  name: "quote-workflow",
  version: "1.0.0",
  flow: [
    start(QuoteWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(QuoteDeskAgent)
      .toFinish(QuoteWorkflowFinish),
  ],
  defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
  providers: [BillingDeskA2AAgent, OpenCallerResolver],
})
export class QuoteWorkflow {}

@Workflow({
  name: "refund-workflow",
  version: "1.0.0",
  flow: [
    start(RefundWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(RefundWorkflowFinish),
  ],
})
export class RefundWorkflow {}

@Workflow({
  name: "kb-workflow",
  version: "1.0.0",
  flow: [
    start(KbWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(KbDeskAgent)
      .toFinish(KbWorkflowFinish),
  ],
  defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
  mcp: [KbServer],
})
export class KbWorkflow {}

@A2AExpose({
  name: "shop-a2a-expose",
  version: "2.0.0",
  exports: [QuoteWorkflowStart, RefundWorkflowStart],
})
export class ShopA2AExpose {}

@A2AExpose({ name: "quote-a2a-expose", version: "1.0.0", exports: [QuoteWorkflowStart] })
export class QuoteA2AExpose {}

@McpExpose({ name: "shop-mcp-expose", version: "1.0.0", exports: [RefundWorkflowStart] })
export class ShopMcpExpose {}

/** The shop served over A2A: two exported starts, one listed expose left out of `exposes`. */
@Application({
  name: "shop-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [QuoteWorkflow, RefundWorkflow],
  budgets: TEST_BUDGETS,
  exposes: [ShopA2AExpose, ShopMcpExpose],
})
export class ShopApplication {}

/** The same with a knowledge base: what `describe --json` lists (assembled, never started). */
@Application({
  name: "shop-kb-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [QuoteWorkflow, RefundWorkflow, KbWorkflow],
  budgets: TEST_BUDGETS,
  exposes: [ShopA2AExpose, ShopMcpExpose],
})
export class ShopKbApplication {}
