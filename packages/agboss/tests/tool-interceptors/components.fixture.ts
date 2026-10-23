/**
 * The tools and tool interceptors of the #384 test application: a job search with its tenant's
 * allowed cities, a company lookup (local and over MCP), a ping tool whose interceptor misbehaves on
 * request. Every interceptor writes what it saw to `interceptorLog`, in order.
 */
import {
  ExecutionContext,
  TenantContext,
  Tool,
  ToolCallDecision,
  ToolInterceptor,
  type AfterToolCall,
  type BeforeToolCall,
  type ToolCallContext,
  type ToolCallResultContext,
  type ToolHandler,
} from "../../src/index.js";
import { ListOf, Text } from "../../src/dto/index.js";
import { McpServer, McpServerClient, McpTool } from "../../src/mcp/index.js";

export class JobScoutTenantContext extends TenantContext {
  @ListOf(Text)
  allowedCities!: string[];
}

export class JobQuery {
  @Text({ prompt: "the city" })
  city!: string;
}

export class JobList {
  @Text({ prompt: "the jobs found" })
  listing!: string;
}

export class CompanyQuery {
  @Text({ prompt: "the company" })
  company!: string;
}

export class CompanyInfo {
  @Text({ prompt: "what the company does" })
  summary!: string;
}

export class PingQuery {
  @Text({ prompt: "throw, nothing, shape, big or ok" })
  mode!: string;
}

export class PingReply {
  @Text({ prompt: "the reply" })
  text!: string;
}

/** One thing an interceptor saw: its hook, the tool, the input, the output, the call's key. */
export interface InterceptorEntry {
  readonly by: string;
  readonly tool: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly idempotencyKey?: string;
}

/** What the interceptors saw, in order (cleared before each test). */
export const interceptorLog: InterceptorEntry[] = [];

/** What the tools themselves ran with, in order (cleared before each test). */
export const toolRuns: string[] = [];

/** A domain error of a scope service: a side path catches it through the step's cause. */
export class ScopeServiceDownError extends Error {
  override name = "ScopeServiceDownError";
}

const isRecordWith = (value: unknown, key: string): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && key in value;

/** The application's: sees every call (outer), in the call's frame; changes nothing. */
@ToolInterceptor({
  name: "audit-tool-interceptor",
  description: "Writes every tool call to the audit log",
  deps: [ExecutionContext],
})
export class AuditToolInterceptor implements BeforeToolCall, AfterToolCall {
  constructor(private readonly executionContext: ExecutionContext) {}

  beforeToolCall(call: ToolCallContext): ToolCallDecision {
    const { idempotencyKey } = this.executionContext.step;
    interceptorLog.push({
      by: "audit:before",
      tool: call.tool.name,
      input: call.input,
      idempotencyKey,
    });
    return ToolCallDecision.allow();
  }

  afterToolCall(call: ToolCallResultContext): unknown {
    interceptorLog.push({
      by: "audit:after",
      tool: call.tool.name,
      input: call.input,
      output: call.output,
    });
    return call.output;
  }
}

/** The issue's example (the workflow's): a city outside the tenant's goes back to the model. */
@ToolInterceptor({
  name: "tenant-scope-tool-interceptor",
  description: "Checks that tool arguments respect the tenant's allowed cities",
  deps: [JobScoutTenantContext],
})
export class TenantScopeToolInterceptor implements BeforeToolCall {
  constructor(private readonly jobScoutTenantContext: JobScoutTenantContext) {}

  beforeToolCall(call: ToolCallContext): Promise<ToolCallDecision> {
    interceptorLog.push({ by: "scope:before", tool: call.tool.name, input: call.input });
    if (
      typeof call.input === "object" &&
      call.input !== null &&
      "city" in call.input &&
      typeof call.input.city === "string" &&
      !this.jobScoutTenantContext.allowedCities.includes(call.input.city)
    ) {
      return Promise.resolve(
        ToolCallDecision.replyToModel({
          message: `City "${call.input.city}" is not allowed for this tenant.`,
        }),
      );
    }
    return Promise.resolve(ToolCallDecision.allow());
  }
}

/** On the company tools: a sanctioned company is blocked — the step fails. */
@ToolInterceptor({
  name: "company-block-tool-interceptor",
  description: "Blocks lookups of sanctioned companies",
})
export class CompanyBlockToolInterceptor implements BeforeToolCall {
  beforeToolCall(call: ToolCallContext): ToolCallDecision {
    interceptorLog.push({ by: "block:before", tool: call.tool.name, input: call.input });
    return isRecordWith(call.input, "company") && call.input.company === "evil-corp"
      ? ToolCallDecision.block({ reason: "evil-corp is sanctioned" })
      : ToolCallDecision.allow();
  }
}

/** On the job search tool (inner): stamps the result the model reads. */
@ToolInterceptor({
  name: "stamp-tool-interceptor",
  description: "Marks job listings as checked",
})
export class StampToolInterceptor implements AfterToolCall {
  afterToolCall(call: ToolCallResultContext): unknown {
    interceptorLog.push({
      by: "stamp:after",
      tool: call.tool.name,
      input: call.input,
      output: call.output,
    });
    const listing = isRecordWith(call.output, "listing") ? String(call.output.listing) : "";
    return { listing: `${listing} (checked)` };
  }
}

/** The scout agent's: misbehaves on a ping call as its `mode` says. */
@ToolInterceptor({
  name: "moody-tool-interceptor",
  description: "Throws, decides nothing or answers the wrong shape when asked to",
})
export class MoodyToolInterceptor implements BeforeToolCall, AfterToolCall {
  beforeToolCall(call: ToolCallContext): ToolCallDecision {
    const mode = isRecordWith(call.input, "mode") ? call.input.mode : undefined;
    if (mode === "throw") throw new ScopeServiceDownError("the scope service is down");
    // a project written without types: no decision at all
    if (mode === "nothing") return Reflect.get({}, "decision") as ToolCallDecision;
    return ToolCallDecision.allow();
  }

  afterToolCall(call: ToolCallResultContext): unknown {
    const mode = isRecordWith(call.input, "mode") ? call.input.mode : undefined;
    if (mode === "big") return { text: "y ".repeat(2048) };
    return mode === "shape" ? { wrong: 1 } : call.output;
  }
}

@Tool({
  name: "job-search-tool",
  description: "Finds jobs in a city",
  input: JobQuery,
  output: JobList,
  toolInterceptors: [StampToolInterceptor],
})
export class JobSearchTool implements ToolHandler<JobQuery, JobList> {
  run({ city }: JobQuery): Promise<JobList> {
    toolRuns.push(`job-search-tool:${city}`);
    return Promise.resolve({ listing: `Engineer in ${city}, write to hr@acme.com` });
  }
}

@Tool({
  name: "company-tool",
  description: "What a company does",
  input: CompanyQuery,
  output: CompanyInfo,
  toolInterceptors: [CompanyBlockToolInterceptor],
  excludeToolInterceptors: [AuditToolInterceptor],
})
export class CompanyTool implements ToolHandler<CompanyQuery, CompanyInfo> {
  run({ company }: CompanyQuery): Promise<CompanyInfo> {
    toolRuns.push(`company-tool:${company}`);
    return Promise.resolve({ summary: `${company} builds things` });
  }
}

@Tool({ name: "ping-tool", description: "Answers pong", input: PingQuery, output: PingReply })
export class PingTool implements ToolHandler<PingQuery, PingReply> {
  run({ mode }: PingQuery): Promise<PingReply> {
    toolRuns.push(`ping-tool:${mode}`);
    return Promise.resolve({ text: "pong" });
  }
}

const boardTools = { lookup: { input: CompanyQuery, output: CompanyInfo } };

/** A job board over MCP (stubbed in tests: `mcpOf(JobBoardServer)`). */
@McpServer({
  name: "board",
  transport: "stdio",
  command: process.execPath,
  args: [],
  tools: boardTools,
})
export class JobBoardServer extends McpServerClient<typeof boardTools> {}

@McpTool({
  server: JobBoardServer,
  name: "board-lookup-tool",
  description: "A company on the job board",
  input: CompanyQuery,
  output: CompanyInfo,
  toolInterceptors: [CompanyBlockToolInterceptor],
  deps: [JobBoardServer],
})
export class BoardLookupTool implements ToolHandler<CompanyQuery, CompanyInfo> {
  constructor(private readonly server: JobBoardServer) {}

  run(query: CompanyQuery): Promise<CompanyInfo> {
    return this.server.call("lookup", query);
  }
}
