import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  Agent,
  ExecutionContext,
  Workflow,
  WorkflowSettings,
  type WorkflowDefinition,
  Tool,
  inline,
  Ttl,
  EmptyEnvironment,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import type { BuildApplicationOptions } from "../../src/application/create-app.js";
import { connectMcp, McpEndpoint, type McpSessionOptions } from "../../src/mcp/index.js";
import { Text } from "../../src/dto/index.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { McpStubs, stubbedMcpConnect } from "../../src/testing/mcp-stubs.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";
import { Window2Memory } from "../helpers/window-memory.js";
import { plainApp } from "../helpers/mcp-plain-app.js";
import { onStart } from "../helpers/flow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { ChatStart, OrderBook, OrderQuery, Reply } from "../testing/fixtures/desk.workflow.js";

function offline(book: ScriptBook): BuildApplicationOptions {
  return {
    processEnv: {},
    gateway: createScriptedGateway(book),
    connectMcp: stubbedMcpConnect(new McpStubs(book), new Map(), new Set()),
  };
}

class TenantEcho {
  @Text() tenantId!: string;
  @Text() key!: string;
  @Text() owner!: string;
}

@Tool({
  name: "tenant-echo-tool",
  description: "Echoes tenant",
  input: OrderQuery,
  output: TenantEcho,
  deps: [ExecutionContext],
})
class TenantEchoTool {
  constructor(private readonly executionContext: ExecutionContext) {}
  execute(): Promise<TenantEcho> {
    const ctx = this.executionContext;
    return Promise.resolve({
      tenantId: ctx.tenant.tenantId,
      key: ctx.step.idempotencyKey,
      owner: String(ctx.ownerId),
    });
  }
}

@McpEndpoint({ name: "echo-mcp", version: "1.0.0", tools: [TenantEchoTool] })
class EchoMcp {}

@Agent({
  name: "echo-agent",
  prompt: inline("x"),
  description: "x",
  model: "test/clerk",
  price: { inputPerMTok: 1, outputPerMTok: 2 },
  tools: [TenantEchoTool],
})
class EchoAgent {}

@Workflow({
  name: "echo-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChatStart).toAgent(EchoAgent).toFinish(Reply)],
  defaults: {
    models: { temperature: 0, cache: true },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 2 },
  },
  memory: Window2Memory,
  providers: [OrderBook],
})
class EchoDesk implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder().build();
  }
}

@Application({
  name: "echo-desk-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EchoDesk],
  budgets: TEST_BUDGETS,
})
class EchoDeskApplication {}

async function client(session: McpSessionOptions) {
  const book = new ScriptBook();
  const app = await createTestAppWith(EchoDeskApplication, offline(book));
  const [c, s] = InMemoryTransport.createLinkedPair();
  await connectMcp(plainApp(app), { endpoint: EchoMcp, transport: s, session });
  const cl = new Client({ name: "t", version: "1" });
  await cl.connect(c);
  return { cl, app };
}

describe("an exported tool over MCP runs in its session tenant and owner", () => {
  it("runs in the session's tenant, and two tenants' same callId get different keys", async () => {
    const a = await client({ tenant: { tenantId: "acme" }, ownerId: "dana" });
    const b = await client({ tenant: { tenantId: "globex" }, ownerId: "eve" });
    const ra = await a.cl.callTool({
      name: "tenant-echo-tool",
      arguments: { orderId: "1" },
      _meta: { callId: "c-1" },
    });
    const rb = await b.cl.callTool({
      name: "tenant-echo-tool",
      arguments: { orderId: "1" },
      _meta: { callId: "c-1" },
    });
    await a.app.close();
    await b.app.close();
    const [outA, outB] = [ra, rb].map(
      (r) => r.structuredContent as { tenantId: string; key: string; owner: string },
    );
    expect(outA).toMatchObject({ tenantId: "acme", owner: "dana" });
    expect(outB).toMatchObject({ tenantId: "globex", owner: "eve" });
    expect(outA?.key).not.toBe(outB?.key);
  });
});
