import { A2AAgent, A2AClient, A2AEndpoint } from "../../../src/a2a/index.js";
import { Application } from "../../../src/application/application.js";
import { McpServer } from "../../../src/components/decorators.js";
import { McpTransport } from "../../../src/config/mcp-server-config.js";
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
} from "../../../src/index.js";
import { McpEndpoint } from "../../../src/mcp/index.js";
import { defineEnv, secret } from "../../../src/environments/index.js";
import { DatabaseStorage, SqliteDriver } from "../../../src/storage/index.js";
import { hours, minutes, usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { HttpAuthResult, HttpAuthenticator } from "../../../src/index.js";

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
  target: { application: "billing-application", skill: "billing-workflow-start" },
  input: InvoiceQuestionDto,
  output: InvoiceAnswerDto,
  costPerCall: usd(0.05),
})
export class BillingDeskA2AAgent extends A2AClient<InvoiceQuestionDto, InvoiceAnswerDto> {}

/** #812: a peer that is not an AGBoss application, typed and untyped: listed as foreign. */
@A2AAgent({
  name: "weather-a2a-agent",
  url: "http://weather.invalid",
  input: InvoiceQuestionDto,
  output: InvoiceAnswerDto,
})
export class WeatherA2AAgent extends A2AClient<InvoiceQuestionDto, InvoiceAnswerDto> {}

@A2AAgent({ name: "oracle-a2a-agent", url: "http://oracle.invalid" })
export class OracleA2AAgent extends A2AClient {}

@Tool({
  name: "ask-billing-tool",
  description: "Asks the billing desk",
  input: InvoiceQuestionDto,
  output: InvoiceAnswerDto,
  deps: [BillingDeskA2AAgent],
})
export class AskBillingTool {
  constructor(private readonly billingDeskA2AAgent: BillingDeskA2AAgent) {}

  execute(question: InvoiceQuestionDto): Promise<InvoiceAnswerDto> {
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
  transport: McpTransport.Stdio,
  command: "kb-server",
  target: { application: "kb-application", endpoint: "kb-mcp-expose" },
  tools: kbTools,
})
export class KbServer extends McpServerClient<typeof kbTools> {}

@Tool({
  name: "search-kb-tool",
  description: "Searches the knowledge base",
  input: SearchQueryDto,
  output: SearchHitDto,
  deps: [KbServer],
})
export class SearchKbTool {
  constructor(private readonly kbServer: KbServer) {}

  execute(query: SearchQueryDto): Promise<SearchHitDto> {
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

@HttpAuthenticator()
export class OpenAuthenticator {
  authenticate(): HttpAuthResult {
    return HttpAuthResult.authenticated({});
  }
}

@Workflow({
  name: "quote-workflow",
  version: "1.0.0",
  flow: [
    onStart(QuoteWorkflowStart)
      .toAgent(QuoteDeskAgent)
      .toFinish(QuoteWorkflowFinish),
  ],
  defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
  providers: [BillingDeskA2AAgent, WeatherA2AAgent, OracleA2AAgent, OpenAuthenticator],
})
export class QuoteWorkflow {}

@Workflow({
  name: "refund-workflow",
  version: "1.0.0",
  flow: [
    onStart(RefundWorkflowStart)
      .toFinish(RefundWorkflowFinish),
  ],
})
export class RefundWorkflow {}

@Workflow({
  name: "kb-workflow",
  version: "1.0.0",
  flow: [
    onStart(KbWorkflowStart)
      .toAgent(KbDeskAgent)
      .toFinish(KbWorkflowFinish),
  ],
  defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
})
export class KbWorkflow {}

@A2AEndpoint({
  name: "shop-a2a-expose",
  description: "Served over A2A",
  version: "2.0.0",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [QuoteWorkflowStart, RefundWorkflowStart],
})
export class ShopA2AExpose {}

@A2AEndpoint({
  name: "quote-a2a-expose",
  description: "Served over A2A",
  version: "1.0.0",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [QuoteWorkflowStart],
})
export class QuoteA2AExpose {}

@McpEndpoint({ name: "shop-mcp-expose", version: "1.0.0", tools: [RefundWorkflowStart] })
export class ShopMcpEndpoint {}

/** The shop served over A2A: two exported starts, one listed expose left out of `exposes`. */
@Application({
  name: "shop-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [QuoteWorkflow, RefundWorkflow],
  budgets: TEST_BUDGETS,
  endpoints: [ShopA2AExpose, ShopMcpEndpoint],
})
export class ShopApplication {}

const shopSecrets = defineEnv({ idempotencySecret: secret("AGBOSS_IDEMPOTENCY_SECRET") });

/** The shop's rows (#1321): its tool reaches the billing desk, so the application names a key. */
@DatabaseStorage({
  driver: SqliteDriver({ path: ":memory:" }),
  auditLogTtl: hours(1),
  ledgerEntriesTtl: hours(1),
  idempotencySecret: shopSecrets.idempotencySecret,
})
export class ShopDatabaseStorage {}

/** The same with a knowledge base: what `describe --json` lists (assembled, never started). */
@Application({
  name: "shop-kb-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [QuoteWorkflow, RefundWorkflow, KbWorkflow],
  storage: ShopDatabaseStorage,
  budgets: TEST_BUDGETS,
  endpoints: [ShopA2AExpose, ShopMcpEndpoint],
})
export class ShopKbApplication {}
