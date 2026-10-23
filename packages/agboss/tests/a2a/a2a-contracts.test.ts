import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { A2AAgent, A2AClient, A2AExpose, a2aHttpListener, A2AStatus } from "../../src/a2a/index.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { createApp } from "../../src/application/create-app.js";
import type { App } from "../../src/app/types.js";
import { contractsOf } from "../../src/describe/contracts.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { EmptyEnvironment, GraphRuleError, Injectable } from "../../src/index.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  OpenCallerResolver,
  QuoteA2AExpose,
  QuoteWorkflow,
  QuoteWorkflowStart,
  RefundWorkflow,
  ShopA2AExpose,
  ShopApplication,
  ShopKbApplication,
} from "./fixtures/contracts.workflow.js";
import { offline } from "./fixtures/remote.workflow.js";

const apps: App[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  servers.splice(0).forEach((server) => {
    server.closeAllConnections();
    server.close();
  });
});

/** The shop served over A2A with `expose`; its base URL. */
async function shop(book: ScriptBook): Promise<string> {
  const app = await createApp(ShopApplication, offline(book));
  apps.push(app);
  const server = createServer(
    a2aHttpListener(app, { expose: ShopA2AExpose, callerResolver: OpenCallerResolver }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(`${url}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("#398 PR 3: a2aHttpListener serves an @A2AExpose", () => {
  it("a request names the exported start it runs", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:quote-desk-agent").thenReturn(replyWith("Quoted."));
    const url = await shop(book);

    const quote = await post(url, { input: { text: "quote 7" }, start: "quote-workflow-start" });
    const refund = await post(url, { input: { text: "refund 7" }, start: "refund-workflow-start" });

    expect(await quote.json()).toMatchObject({
      status: A2AStatus.Finished,
      finish: "quote-workflow-finish",
      output: { text: "Quoted." },
    });
    expect(await refund.json()).toMatchObject({
      finish: "refund-workflow-finish",
      output: { text: "refund 7" },
    });
  });

  it("no start with several exports, or one it does not export: 400 a2a.unknown-start", async () => {
    const url = await shop(new ScriptBook());

    const unnamed = await post(url, { input: { text: "hi" } });
    const unknown = await post(url, { input: { text: "hi" }, start: "kb-workflow-start" });

    expect(unnamed.status).toBe(400);
    expect(await unnamed.json()).toMatchObject({
      code: "a2a.unknown-start",
      error: expect.stringContaining("quote-workflow-start, refund-workflow-start"),
    });
    expect(await unknown.json()).toMatchObject({
      code: "a2a.unknown-start",
      error: expect.stringContaining("kb-workflow-start is not exported here"),
    });
  });

  it("an expose the application does not list: [application.expose-unlisted]", async () => {
    const app = await createApp(ShopApplication, offline(new ScriptBook()));
    apps.push(app);

    const built = () =>
      a2aHttpListener(app, { expose: QuoteA2AExpose, callerResolver: OpenCallerResolver });

    expect(built).toThrow(/^\[application\.expose-unlisted\] QuoteA2AExpose is not listed/);
  });
});

describe("#398 PR 3: the contracts at assembly", () => {
  it("names, exports and targets are checked, every violation at once", async () => {
    @A2AExpose({ name: "shop-expose", version: "1.0.0", exports: [QuoteWorkflowStart, Object] })
    class ShopExpose {}

    @A2AAgent({
      name: "billing-desk",
      url: "http://billing.invalid",
      target: { application: "", start: "" }, // names nothing
      input: WorkflowStartTextDto,
      output: WorkflowFinishTextDto,
    })
    class BillingDesk extends A2AClient<WorkflowStartTextDto, WorkflowFinishTextDto> {}

    @Injectable()
    class NotAnExpose {}

    @Application({
      name: "broken-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [QuoteWorkflow, RefundWorkflow],
      budgets: TEST_BUDGETS,
      providers: [BillingDesk],
      exposes: [ShopExpose, NotAnExpose, ShopA2AExpose, ShopA2AExpose],
    })
    class BrokenApplication {}

    const built = applicationOf(BrokenApplication);

    await expect(built).rejects.toBeInstanceOf(GraphRuleError);
    const message = await built.catch((error: unknown) => String(error));
    expect(message).toContain(
      '[name.kind-suffix] "shop-expose" on @A2AExpose — name it "shop-expose-a2a-expose"',
    );
    expect(message).toContain("[name.kind-suffix] class ShopExpose — name it ShopExposeA2AExpose");
    expect(message).toContain("[application.expose-unknown-start] shop-expose exports Object");
    expect(message).toContain("[application.not-an-expose] NotAnExpose");
    expect(message).toContain(
      "[application.duplicate-expose] broken-application exposes two contracts named shop-a2a-expose",
    );
    expect(message).toContain(
      '[name.kind-suffix] "billing-desk" on @A2AAgent — name it "billing-desk-a2a-agent"',
    );
    expect(message).toContain("[name.kind-suffix] class BillingDesk — name it BillingDeskA2AAgent");
    expect(message).toContain("[a2a.target-required] billing-desk names no target");
  });
});

describe("#398 PR 3: describe --json lists the declared contracts", () => {
  it("exports by expose and start, imports by client and server, each DTO with its schemaHash", async () => {
    const contracts = contractsOf(await applicationOf(ShopKbApplication));

    expect(contracts.exports).toEqual([
      {
        kind: "a2a",
        expose: "shop-a2a-expose",
        version: "2.0.0",
        start: "quote-workflow-start",
        workflow: "quote-workflow",
        input: { dto: "WorkflowStartTextDto", schemaHash: expect.any(String) },
        outputs: [
          {
            finish: "quote-workflow-finish",
            dto: "WorkflowFinishTextDto",
            schemaHash: expect.any(String),
          },
        ],
      },
      expect.objectContaining({ kind: "a2a", start: "refund-workflow-start" }),
      {
        kind: "mcp",
        expose: "shop-mcp-expose",
        version: "1.0.0",
        tool: "refund-workflow-start",
        input: { dto: "WorkflowStartTextDto", schemaHash: expect.any(String) },
      },
    ]);
    expect(contracts.imports).toEqual([
      {
        kind: "a2a",
        client: "billing-desk-a2a-agent",
        target: { application: "billing-application", start: "billing-workflow-start" },
        usedBy: [{ workflow: "quote-workflow", tool: "ask-billing-tool" }],
        input: { dto: "InvoiceQuestionDto", schemaHash: expect.any(String) },
        output: { dto: "InvoiceAnswerDto", schemaHash: expect.any(String) },
        price: 0.05,
      },
      {
        kind: "mcp",
        server: "kb",
        tool: "search",
        target: { application: "kb-application", expose: "kb-mcp-expose" },
        input: { dto: "SearchQueryDto", schemaHash: expect.any(String) },
        output: { dto: "SearchHitDto", schemaHash: expect.any(String) },
      },
    ]);
    expect(Object.keys(contracts.schemas)).toEqual([
      "InvoiceAnswerDto",
      "InvoiceQuestionDto",
      "SearchHitDto",
      "SearchQueryDto",
      "WorkflowFinishTextDto",
      "WorkflowStartTextDto",
    ]);
    expect(contracts.schemas.InvoiceQuestionDto?.jsonSchema).toMatchObject({
      type: "object",
      properties: { question: { type: "string" } },
    });
  });
});
