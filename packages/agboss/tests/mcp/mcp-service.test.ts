import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AppOptions } from "../../src/app/create-app.js";
import {
  createApp,
  type App,
  Agent,
  ExecutionContext,
  Workflow,
  WorkflowSettings,
  type WorkflowDefinition,
  Tool,
  type ToolHandler,
} from "../../src/index.js";
import { createMcpService, McpExpose } from "../../src/mcp/index.js";
import { TerminalUserChannel } from "../../src/channels/terminal-channel.js";
import { Text } from "../../src/dto/index.js";
import { jsonSchemaOf } from "../../src/dto/schema.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { McpStubs, stubbedMcpConnect } from "../../src/testing/mcp-stubs.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import {
  ChatStart,
  NotesServer,
  OrderBook,
  OrderInfo,
  OrderQuery,
  OrderStatus,
  Reply,
  SaveNote,
  DeskApplication,
} from "../testing/fixtures/desk.workflow.js";
import { start } from "../helpers/flow.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../src/index.js";

function offline(book: ScriptBook, stubs = new McpStubs(book)): AppOptions {
  return {
    processEnv: {},
    gateway: createScriptedGateway(book),
    connectMcp: stubbedMcpConnect(stubs, new Map(), new Set()),
  };
}

class CallEcho {
  @Text() callId!: string;
}

/** Returns its step's call id: proves an MCP call runs in a frame of its own (#280). */
@Tool({
  name: "echo_call",
  description: "Echoes the call id",
  input: OrderQuery,
  output: CallEcho,
  deps: [ExecutionContext],
})
class EchoCall implements ToolHandler<OrderQuery, CallEcho> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(): Promise<CallEcho> {
    return Promise.resolve({ callId: String(this.executionContext.step.callId) });
  }
}

class Code {
  @Text({ prompt: "a three-letter code", minLength: 3 })
  code!: string;
}

/** Breaks its own output DTO: the adapter must reject the result. */
@Tool({ name: "broken", description: "Wrong output", input: OrderQuery, output: Code })
class Broken implements ToolHandler<OrderQuery, Code> {
  run(): Promise<Code> {
    return Promise.resolve({ code: "x" });
  }
}

@Agent({
  name: "clerk-agent",
  prompt: "Answer questions about orders and keep notes.",
  description: "Orders and notes",
  model: "test/clerk",
  price: { inputPerMTok: 1, outputPerMTok: 2 },
  tools: [OrderStatus, EchoCall, Broken, SaveNote],
})
class Clerk {}

/** A workflow whose tools and start the MCP server exposes. */
@Workflow({
  name: "clerk-desk-workflow",
  version: "1.0.0",
  flow: [start(ChatStart).returns(WorkflowStartTextDto).toAgent(Clerk).toFinish(Reply)],
  defaults: {
    models: { temperature: 0, cache: true },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 2 },
    history: { limit: 2 },
  },
  channelClasses: [TerminalUserChannel],
  mcp: [NotesServer],
  providers: [OrderBook],
})
class ClerkDesk implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder().build();
  }
}

@Application({
  name: "clerk-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClerkDesk],
  budgets: TEST_BUDGETS,
})
export class ClerkDeskApplication {}

@McpExpose({
  name: "desk-mcp",
  version: "1.0.0",
  exports: [OrderStatus, EchoCall, Broken, ChatStart, Clerk],
})
class DeskMcp {}

const opened: App[] = [];

/** The app behind an MCP server, and an SDK client connected to it in memory. */
async function connected(book = new ScriptBook(), stubs = new McpStubs(book)): Promise<Client> {
  const app = await createApp(ClerkDeskApplication, offline(book, stubs));
  opened.push(app);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpService(app, DeskMcp).connect(serverSide);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string => {
  const [first] = result.content as readonly { type: string; text?: string }[];
  return first?.text ?? "";
};

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

describe("McpService over an in-memory MCP transport", () => {
  it("lists the exported tools, the workflow start and resume_workflow with their JSON schemas", async () => {
    const client = await connected();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "order_status",
      "echo_call",
      "broken",
      "chat-workflow-start",
      "resume_workflow",
    ]);
    const orderStatus = tools.find((tool) => tool.name === "order_status");
    expect(orderStatus).toMatchObject({
      description: "The status of an order",
      inputSchema: { ...jsonSchemaOf(OrderQuery), type: "object" },
      outputSchema: { ...jsonSchemaOf(OrderInfo), type: "object" },
    });
    expect(orderStatus?.inputSchema.required).toEqual(["orderId"]);
  });

  it("calls a tool through the tool adapter and returns the validated result", async () => {
    const client = await connected();

    const result = await client.callTool({ name: "order_status", arguments: { orderId: "42" } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "order 42 shipped" });
    expect(JSON.parse(textOf(result))).toEqual({ status: "order 42 shipped" });
  });

  it("invalid input and invalid output come back as MCP error results", async () => {
    const client = await connected();

    const badInput = await client.callTool({ name: "order_status", arguments: { orderId: 7 } });
    const badOutput = await client.callTool({ name: "broken", arguments: { orderId: "1" } });

    expect(badInput.isError).toBe(true);
    expect(textOf(badInput)).toMatch(/^Tool error: invalid input: orderId/);
    expect(badOutput.isError).toBe(true);
    expect(textOf(badOutput)).toMatch(/^Tool error: invalid output: code/);
  });

  it("the client's _meta.callId is the tool's idempotency key; without it each call gets its own", async () => {
    const client = await connected();
    const call = (meta?: Record<string, unknown>) =>
      client.callTool({
        name: "echo_call",
        arguments: { orderId: "1" },
        ...(meta ? { _meta: meta } : {}),
      });

    const keyed = await call({ callId: "order-1-attempt" });
    const first = await call();
    const second = await call();

    expect(keyed.structuredContent).toEqual({ callId: "order-1-attempt" });
    expect(first.structuredContent).not.toEqual(second.structuredContent);
  });

  it("an unknown tool is a JSON-RPC error", async () => {
    const client = await connected();

    await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toThrow(
      /Tool not found: nope/,
    );
  });

  it("runs the workflow start, pauses, and resume_workflow finishes the same thread", async () => {
    const book = new ScriptBook();
    const stubs = new McpStubs(book);
    stubs.stubOf("notes").thenReturn({ write_file: () => Promise.resolve({ content: "ok" }) });
    book
      .scriptOf("agent:clerk-agent")
      .thenReturn(callTool(SaveNote, { title: "a", text: "b" }), replyWith("Saved."));
    const client = await connected(book, stubs);

    const started = await client.callTool({
      name: "chat-workflow-start",
      arguments: { text: "save a note" },
    });
    const paused = JSON.parse(textOf(started)) as { status: string; threadId: string };
    const resumed = await client.callTool({
      name: "resume_workflow",
      arguments: {
        threadId: paused.threadId,
        decision: JSON.stringify({ approved: true, by: "dana" }),
      },
    });

    expect(paused).toMatchObject({
      status: ExecutionStatus.Paused,
      pauseDetails: { agent: "clerk-agent", tool: "save_note" },
    });
    expect(resumed.isError).toBeFalsy();
    expect(JSON.parse(textOf(resumed))).toEqual({ text: "Saved." });
  });

  it("an invalid workflow input or an unknown thread is an MCP error result", async () => {
    const client = await connected();

    const badStart = await client.callTool({
      name: "chat-workflow-start",
      arguments: { text: "" },
    });
    const badResume = await client.callTool({
      name: "resume_workflow",
      arguments: { threadId: "missing", decision: "{}" },
    });

    expect(badStart).toMatchObject({ isError: true });
    expect(textOf(badStart)).toMatch(/^Error: .*text/);
    expect(badResume).toMatchObject({ isError: true });
    expect(textOf(badResume)).toMatch(/missing/);
  });

  it("exporting a tool the workflow does not use fails when the server starts", async () => {
    const app = await createApp(DeskApplication, offline(new ScriptBook()));
    opened.push(app);
    const [, serverSide] = InMemoryTransport.createLinkedPair();

    await expect(createMcpService(app, DeskMcp).connect(serverSide)).rejects.toThrow(
      /exports EchoCall, which is not a tool of application "desk-application"/,
    );
  });
});
