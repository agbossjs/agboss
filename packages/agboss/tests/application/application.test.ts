/**
 * #261 PR 2, AC1 / AC16: `@Application` is the one entry — `createApp(App, { env })` and
 * `testWith(App)`; `app.execute(Start, …)` runs any workflow of the application by its start,
 * `resume` / `cancel` the workflow of the thread; one container for the whole application.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import type { Class } from "../../src/components/injection.js";
import { GraphRuleError } from "../../src/index.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { usd } from "../../src/units/index.js";
import { ChatWorkflow } from "../flow/fixtures/chat.fixture.js";
import { TestTenantDailyBudget } from "../flow/fixtures/budgets.js";
import { execute } from "../helpers/flow.js";
import {
  AmbiguousApplication,
  DeskDirectoryService,
  DesksApplication,
  OrdersAgent,
  OrdersWorkflowFinish,
  OrdersWorkflowStart,
  RecordingCostLedgerRepository,
  RefundsAgent,
  RefundsWorkflowFinish,
  RefundsWorkflowStart,
  SpendReportService,
  started,
} from "./fixtures/desks.application.js";

const desks = testWith(DesksApplication);

beforeEach(() => {
  started.length = 0;
});

describe("#261 AC1: app.execute runs any workflow of the application by its start", () => {
  desks("any workflow by its start", async ({ app, mockLlm }) => {
    mockLlm(OrdersAgent).thenReturn(replyWith("order 7 shipped"));
    mockLlm(RefundsAgent).thenReturn(replyWith("refund sent"));

    const order = await execute(app, OrdersWorkflowStart, { text: "where is order 7?" });
    const refund = await execute(app, RefundsWorkflowStart, { text: "refund order 7" });

    expect(order).toFinishWith(OrdersWorkflowFinish, { text: "order 7 shipped" });
    expect(refund).toFinishWith(RefundsWorkflowFinish, { text: "refund sent" });
    expect(order.threadId).not.toBe(refund.threadId);
  });

  desks("a thread continues in its own workflow; cancel finds it", async ({ app, mockLlm }) => {
    mockLlm(RefundsAgent).thenReturn(replyWith("first"), replyWith("second"));

    const first = await execute(app, RefundsWorkflowStart, { text: "refund" });
    const second = await execute(
      app,
      RefundsWorkflowStart,
      { text: "again" },
      { threadId: first.threadId },
    );

    expect(second.threadId).toBe(first.threadId);
    expect(await app.cancel(first.threadId)).toEqual({ cancelled: false });
  });

  it("the app carries the application's name and version, not a workflow's", async () => {
    const app = await createApp(DesksApplication, {
      processEnv: {},
      gateway: createScriptedGateway(new ScriptBook()),
    });

    expect([app.name, app.version]).toEqual(["desks-application", "3.1.0"]);
    await app.close();
  });

  it("ambiguous start: one start in two workflows fails assembly", async () => {
    const built = createApp(AmbiguousApplication, { processEnv: {} });

    await expect(built).rejects.toBeInstanceOf(GraphRuleError);
    await expect(built).rejects.toThrow(
      "[application.ambiguous-start] orders-workflow-start is a start of orders-workflow and orders-copy-workflow — a start is the door of one workflow; give each workflow its own",
    );
  });

  it("createApp(Workflow) and testWith(Workflow) do not compile, and fail naming the fix", async () => {
    // @ts-expect-error — a @Workflow is not an application (the generated types brand it)
    const compiled = (): unknown => createApp(ChatWorkflow);
    // @ts-expect-error — testWith takes an @Application too
    const tested = (): unknown => testWith(ChatWorkflow);
    const workflow: Class = ChatWorkflow;

    await expect(createApp(workflow)).rejects.toThrow(
      "createApp takes an @Application class: ChatWorkflow is a @Workflow — list it in an @Application({ name, version, workflows: [ChatWorkflow] }) and pass the application",
    );
    expect([compiled, tested]).toHaveLength(2);
  });
});

describe("#261 AC2: one container for the application", () => {
  desks("a class listed by two workflows is one instance", async ({ app }) => {
    await app.ready();

    expect(started).toEqual(["DeskDirectoryService.constructor", "DeskDirectoryService.onInit"]);
  });

  it("a workflow's service gets the ledger the application lists; spend is saved there", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:orders-agent").thenReturn(replyWith("ok", { cost: usd(0.25) }));
    const app = await createApp(DesksApplication, {
      processEnv: {},
      gateway: createScriptedGateway(book),
    });

    await execute(app, OrdersWorkflowStart, { text: "where is order 7?" });
    const { costLedgerRepository } = app.resolve(SpendReportService);

    expect(costLedgerRepository).toBeInstanceOf(RecordingCostLedgerRepository);
    expect(costLedgerRepository).toBe(app.resolve(RecordingCostLedgerRepository));
    expect(app.resolve(DeskDirectoryService)).toBe(app.resolve(DeskDirectoryService));
    const saved = app.resolve(RecordingCostLedgerRepository).saved;
    // every call counted in each budget of the execution (the test budgets: one per scope)
    expect(saved.map((entry) => entry.budgets)).toEqual([
      ["test-application-daily-budget", "test-tenant-daily-budget", "test-execution-budget"],
    ]);
    expect(saved.flatMap((entry) => entry.records.map((record) => record.costUsd))).toEqual([0.25]);
    await app.close();
  });
});

describe("#261 AC16: testWith(Application) — lazy app, budgets are components", () => {
  desks("app.ready() builds the application once; a second call does nothing", async ({ app }) => {
    await app.ready();
    await app.ready();

    expect(started).toHaveLength(2);
  });

  desks("a budget of the application can be mocked", async ({ app, mockOf }) => {
    mockOf(TestTenantDailyBudget).maxSpend.mockReturnValue(usd(0.01));

    await app.ready();

    expect(mockOf(TestTenantDailyBudget).maxSpend()).toBe(0.01);
  });
});
