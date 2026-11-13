import { createAppWith } from "../../src/application/create-app.js";
import { afterEach, describe, expect, it } from "vitest";
import { A2AAgent, A2AClient, A2AExpose, a2aHttpListener } from "../../src/a2a/index.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("#398 PR 3: a2aHttpListener serves an @A2AExpose", () => {
  it("an expose the application does not list: [application.expose-unlisted]", async () => {
    const app = await createAppWith(ShopApplication, offline(new ScriptBook()));
    apps.push(app);

    const built = () =>
      a2aHttpListener(app, {
        expose: QuoteA2AExpose,
        callerResolver: OpenCallerResolver,
        publicUrl: "http://127.0.0.1",
      });

    expect(built).toThrow(/^\[application\.expose-unlisted\] QuoteA2AExpose is not listed/);
  });
});

describe("#398 PR 3: the contracts at assembly", () => {
  it("names, exports and targets are checked, every violation at once", async () => {
    @A2AExpose({
      name: "shop-expose",
      version: "1.0.0",
      description: "A shop",
      exports: [QuoteWorkflowStart, Object],
    })
    class ShopExpose {}

    @A2AAgent({
      name: "billing-desk",
      url: "http://billing.invalid",
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
    // #809: a target is optional (a foreign agent has none): no [a2a.target-required]
    expect(message).not.toContain("a2a.target-required");
  });
});

describe("#398 PR 3: describe --json lists the declared contracts", () => {
  it("AC2: exports by expose and skill, imports (a foreign peer with foreign: true) by client and server, each DTO with its schemaHash", async () => {
    const contracts = contractsOf(await applicationOf(ShopKbApplication));

    expect(contracts.exports).toEqual([
      {
        kind: "a2a",
        expose: "shop-a2a-expose",
        version: "2.0.0",
        skill: "quote-workflow-start",
        workflow: "quote-workflow",
        input: { dto: "WorkflowStartTextDto", schemaHash: expect.any(String) },
        outputs: [
          {
            finish: "quote-workflow-finish",
            dto: "WorkflowFinishTextDto",
            schemaHash: expect.any(String),
          },
        ],
        reply: "task",
        cardFileFields: "extension",
      },
      expect.objectContaining({ kind: "a2a", skill: "refund-workflow-start" }),
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
        foreign: false,
        target: { application: "billing-application", skill: "billing-workflow-start" },
        usedBy: [{ workflow: "quote-workflow", tool: "ask-billing-tool" }],
        input: { dto: "InvoiceQuestionDto", schemaHash: expect.any(String) },
        output: { dto: "InvoiceAnswerDto", schemaHash: expect.any(String) },
        price: 0.05,
      },
      {
        kind: "a2a",
        client: "weather-a2a-agent",
        foreign: true,
        target: null,
        usedBy: [],
        input: { dto: "InvoiceQuestionDto", schemaHash: expect.any(String) },
        output: { dto: "InvoiceAnswerDto", schemaHash: expect.any(String) },
        price: null,
      },
      {
        kind: "a2a",
        client: "oracle-a2a-agent",
        foreign: true,
        target: null,
        usedBy: [],
        input: null,
        output: null,
        price: null,
      },
      {
        kind: "mcp",
        server: "kb",
        tool: "search",
        target: { application: "kb-application", expose: "kb-mcp-expose" },
        usedBy: [{ workflow: "kb-workflow", tool: "search-kb-tool" }],
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
