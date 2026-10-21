import { describe, expect, it, vi } from "vitest";
import { createAppDeps } from "../../src/app/app-deps.js";
import { createApp } from "../../src/application/create-app.js";
import { toolLookup, UnknownToolError } from "../../src/app/parts.js";
import { runResultOf } from "../../src/app/result.js";
import { workflowOf } from "../../src/testing/index.js";
import {
  Agent,
  Workflow,
  WorkflowSettings,
  WorkflowStart,
  type WorkflowDefinition,
} from "../../src/index.js";
import { Text } from "../../src/dto/index.js";
import { buildCostReport } from "../../src/finops/usage.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { Desk, OrderBook, Reply } from "../testing/fixtures/desk.workflow.js";
import { start } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../src/index.js";

const offline = () => ({
  gateway: createScriptedGateway(new ScriptBook()),
  stores: { terns: createSqliteTernStore(":memory:", () => new Date()) },
});

class TicketDto {
  @Text({ prompt: "the ticket" })
  text!: string;
}

@WorkflowStart({ name: "ticket-workflow-start", description: "A ticket", input: TicketDto })
class TicketStart {}

@Agent({
  name: "ticket-writer-agent",
  description: "Writes ticket replies",
  prompt: "Reply to the ticket.",
  model: "test/writer",
  input: { ticket: TicketDto },
})
class TicketWriter {}

@Workflow({
  name: "tickets-workflow",
  version: "1.0.0",
  flow: [start(TicketStart).returns(TicketDto).toAgent(TicketWriter).toFinish(Reply)],
  defaults: {
    models: { temperature: 0, cache: true },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 1 },
  },
  uncompactedTurns: 1,
  providers: [OrderBook],
})
class Tickets implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder().build();
  }
}

@Application({
  name: "tickets-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Tickets],
  budgets: TEST_BUDGETS,
})
export class TicketsApplication {}

describe("AC12: the app's parts", () => {
  it("an unknown tool name is a wiring bug", () => {
    expect(() => toolLookup([])("nope")).toThrow(UnknownToolError);
  });

  it("a run's result keeps memory and trace link; the record only when asked", () => {
    const run = {
      status: ExecutionStatus.Finished,
      start: "task-workflow-start",
      startInput: { text: "hi" },
      path: ["task-workflow-start", "coder-agent"],
      budgetUsd: 1,
      cost: buildCostReport([]),
      threadId: "t",
      tenantId: "default",
      ternId: "tern",
      runId: "r",
      data: { scope: {}, outdatedValues: [], lastError: null },
      compacted: [
        {
          compaction: "conversation-compaction",
          fromTurn: 1,
          toTurn: 5,
          summaries: 1,
          summaryQueueLength: 10,
        },
      ],
      traceUrl: "http://traces/t",
      pending: [],
    };

    expect(runResultOf(run, false)).toMatchObject({
      path: ["task-workflow-start", "coder-agent"],
      traceUrl: "http://traces/t",
      compacted: [{ summaryQueueLength: 10 }],
    });
    expect(runResultOf(run, false).record).toBeUndefined();
    expect(runResultOf(run, true).record).toEqual({
      path: run.path,
      scope: [],
      outdatedValues: [],
      spend: run.cost,
      children: [],
      // read from the tree's pause records once the pass ended (#267 S107)
      pauses: [],
    });
  });

  it("with no start of WorkflowStartTextDto, a plain text has no start", async () => {
    const app = await createApp(TicketsApplication, offline());

    expect(app.textStart).toBeUndefined();
    await app.close();
  });

  it("the container reports every instance it creates, besides the app's own lifecycle", async () => {
    const onCreate = vi.fn();
    const noMcp = () => Promise.resolve({ close: () => Promise.resolve() });

    const deps = await createAppDeps(await workflowOf(Desk), {
      ...offline(),
      connectMcp: noMcp,
      container: { onCreate },
    });
    await deps.close();

    expect(onCreate).toHaveBeenCalledWith(expect.any(OrderBook));
  });

  it("env defaults to the process's; a bundle without server tools connects none", async () => {
    const bundle = { ...(await workflowOf(Tickets)), serverTools: undefined };

    const deps = await createAppDeps(bundle, offline());
    await deps.close();

    expect(deps.knowledge).toBeUndefined();
  });

  it("context knowledge bases are looked up per agent; an agent without any gets none", async () => {
    const bundle = {
      ...(await workflowOf(Tickets)),
      knowledge: () => new Map([["ticket-writer-agent", []]]),
    };

    const deps = await createAppDeps(bundle, offline());
    await deps.close();

    expect(deps.knowledge?.("ticket-writer-agent")).toEqual([]);
    expect(deps.knowledge?.("someone")).toEqual([]);
  });
});
