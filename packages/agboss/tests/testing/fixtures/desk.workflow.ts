import { file } from "../../../src/components/file.js";

import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Agent,
  Injectable,
  Workflow,
  type OnStart,
  type OnStop,
  MODEL_MAX,
  Tool,
  type ToolHandler,
  DecidedBy,
  Router,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { Reasoning } from "../../../src/models/index.js";
import { route, start } from "../../helpers/flow.js";
import { McpServer, McpServerClient, McpTool } from "../../../src/mcp/index.js";
import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { TestApplicationDailyBudget } from "../../flow/fixtures/budgets.js";
import {
  Budget,
  BudgetPeriod,
  BudgetScope,
  type BudgetHandler,
} from "../../../src/budgets/budget.js";
import { usd, type Usd } from "../../../src/units/index.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { PromptInjectionGuardrail } from "../../fixtures/guardrails.js";

/** What the lifecycle hooks of real components did, in order (the lifecycle tests read it). */
export const lifecycle: string[] = [];

/** A service with lifecycle hooks: started when the app is built, stopped when it closes. */
@Injectable()
export class OrderBook implements OnStart, OnStop {
  onStart(): void {
    lifecycle.push("OrderBook.onStart");
  }

  onStop(): void {
    lifecycle.push("OrderBook.onStop");
  }

  statusOf(orderId: string): Promise<string> {
    return Promise.resolve(`order ${orderId} shipped`);
  }
}

export class OrderQuery {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

export class OrderInfo {
  @Text()
  status!: string;
}

@Tool({
  name: "order_status",
  description: "The status of an order",
  input: OrderQuery,
  output: OrderInfo,
  deps: [OrderBook],
})
export class OrderStatus implements ToolHandler<OrderQuery, OrderInfo> {
  constructor(private readonly book: OrderBook) {}

  async run({ orderId }: OrderQuery): Promise<OrderInfo> {
    return { status: await this.book.statusOf(orderId) };
  }
}

class FileRead {
  @Text() path!: string;
}

class FileContent {
  @Text() content!: string;
}

class FileWrite {
  @Text() path!: string;
  @Text() content!: string;
}

class FileWritten {
  @Text() content!: string;
}

/** The folder the notes server may touch. */
export const NOTES_DIR = tmpdir();

const FILESYSTEM_SERVER = join(
  dirname(
    createRequire(import.meta.url)
      .resolve("@modelcontextprotocol/server-filesystem/package.json"),
  ),
  "dist",
  "index.js",
);

const notesTools = {
  read_text_file: { input: FileRead, output: FileContent },
  write_file: { input: FileWrite, output: FileWritten },
};

/** A real MCP server (the official filesystem server, a local process — no network). */
@McpServer({
  name: "notes",
  transport: "stdio",
  command: process.execPath,
  args: [FILESYSTEM_SERVER, NOTES_DIR],
  tools: notesTools,
})
export class NotesServer extends McpServerClient<typeof notesTools> {}

export class Note {
  @Text() title!: string;
  @Text() text!: string;
}

export class NoteRef {
  @Text() title!: string;
}

export class NoteText {
  @Text() text!: string;
}

const notePath = (title: string): string => join(NOTES_DIR, `${title}.md`);

@McpTool({
  server: NotesServer,
  name: "save_note",
  description: "Saves a note",
  channel: TerminalUserChannel,
  input: Note,
  output: NoteRef,
  deps: [NotesServer],
})
export class SaveNote implements ToolHandler<Note, NoteRef> {
  constructor(private readonly server: NotesServer) {}

  async run({ title, text }: Note): Promise<NoteRef> {
    await this.server.call("write_file", { path: notePath(title), content: text });
    return { title };
  }
}

@McpTool({
  server: NotesServer,
  name: "read_note",
  description: "Reads a note",
  input: NoteRef,
  output: NoteText,
  deps: [NotesServer],
})
export class ReadNote implements ToolHandler<NoteRef, NoteText> {
  constructor(private readonly server: NotesServer) {}

  async run({ title }: NoteRef): Promise<NoteText> {
    return { text: (await this.server.call("read_text_file", { path: notePath(title) })).content };
  }
}

const price = { inputPerMTok: 1, outputPerMTok: 10 };

@Agent({
  name: "support-agent",
  promptUrls: ["./support.prompt.md"],
  description: "Answers questions about orders and keeps notes",
  model: "test/support",
  price,
  tools: [OrderStatus, ReadNote, SaveNote],
})
export class Support {}

@Agent({
  name: "writer-agent",
  promptUrls: ["./writer.prompt.md"],
  description: "Writes replies",
  model: "test/writer",
  price,
})
export class Writer {}

@WorkflowStart({
  name: "chat-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class ChatStart {}

@WorkflowFinish({
  name: "reply-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class Reply {}

@WorkflowFinish({
  name: "no-reply-workflow-finish",
  description: "Ends without a reply",
  output: WorkflowStartTextDto,
})
export class NoReply {}

@Router({
  name: "main-router",
  description: "Sends the message to an agent, or ends",
  decidedBy: DecidedBy.Model,
  prompt: "Pick who handles the message.",
  model: "typesafe/jev-1.13",
  input: { message: WorkflowStartTextDto },
  maxVisits: 4,
  routes: [
    { prompt: "Orders and notes", target: Support },
    { prompt: "Writing replies", target: Writer },
    { prompt: "Stop without a reply: the message needs none", target: NoReply },
  ],
})
export class MainRouter {}

/** The testing toolkit's own workflow: a star with a service, a tool, an MCP server, a pause. */
@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  maxSteps: 12,
  flow: [
    start(ChatStart)
      .returns(WorkflowStartTextDto)
      .toRouter(MainRouter)
      .chooseOne(
        route(Support)
          .toFinish(Reply),
        route(Writer)
          .toFinish(Reply),
        route(NoReply),
      ),
  ],
  defaults: {
    models: {
      temperature: 0,
      maxTokens: MODEL_MAX,
      reasoning: Reasoning.modelDecides(),
      cache: true,
    },
    router: { model: "typesafe/jev-1.13" },
    guardrail: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 4 },
    history: { limit: 4 },
  },
  guardrails: [PromptInjectionGuardrail],
  mcp: [NotesServer],
  providers: [OrderBook],
})
export class Desk {}

/** $0.05 an execution and $0.05 a day for a tenant. */
@Budget({ name: "desk-execution-budget", scope: BudgetScope.Execution })
export class DeskExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}

@Budget({ name: "desk-tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class DeskTenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}

@Application({
  name: "desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Desk],
  budgets: [TestApplicationDailyBudget, DeskTenantDailyBudget, DeskExecutionBudget],
})
export class DeskApplication {}
