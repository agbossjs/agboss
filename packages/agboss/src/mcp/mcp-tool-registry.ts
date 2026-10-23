import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { App, ExecutionOptions, ExecutionOutput } from "../app/types.js";
import type { ToolHandler } from "../components/decorators.js";
import type { Class } from "../components/injection.js";
import { componentOf, type ToolMeta } from "../components/metadata.js";
import { adapt } from "../components/runtime.js";
import { inMcpCallFrame } from "./mcp-call-frame.js";
import { executeUnchecked } from "../app/execute-unchecked.js";
import { withInboundMesh } from "../mesh/inbound-mesh.js";
import { isMeshLimitError } from "../mesh/mesh-errors.js";
import { runReportMetaOf } from "./mcp-run-report.js";
import { ExecutionStatus } from "../app/types.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf, type WorkflowStartDeclaration } from "../flow/decorators/declaration.js";
import { renderToolResult, type ToolInvocationContext, type ToolOutput } from "../tools/index.js";
import {
  RESUME_TOOL,
  failureResult,
  guarded,
  isRecord,
  objectSchema,
  parseDecision,
  type McpCall,
  type ToolRegistry,
} from "./mcp-service-helpers.js";

/**
 * What every call of one MCP session runs with (#261): the thread's owner and the execution's typed
 * context values — `tenant` (a resume uses its `tenantId`) and the declared `execution` fields —
 * taken by the transport from its authenticated caller, never from the call's arguments.
 */
export type McpSessionOptions = Pick<ExecutionOptions, "ownerId" | "tenant" | "execution"> & {
  /**
   * The mesh peer the transport authenticated (#398 PR 2), by its `@Application({ name })`: when a
   * call's envelope carries this peer's valid signature, its budget, deadline and origin are
   * honoured and the run's report is signed back (`_meta["agboss.dev/report"]`).
   */
  readonly peer?: string;
};

/**
 * What an `@McpExpose` exposes: its `@Tool` / `@McpTool` exports (run through the same adapter as
 * agent tool calls — DTO validation of input and output, timeout, `callId`), its workflow starts
 * (`app.execute`), and `resume_workflow` (`app.resume`) when there is a start.
 */
export function collectTools(
  app: App,
  exports: readonly Class[],
  session: McpSessionOptions,
): ToolRegistry {
  const registry: ToolRegistry = { tools: [], handlers: new Map() };
  let hasWorkflows = false;
  for (const exp of exports) {
    const meta = toolMetaOf(exp);
    if (meta) {
      addTool(registry, { app, exp, meta });
    } else if (isStart(exp)) {
      hasWorkflows = true;
      addWorkflowStart(registry, app, exp, session);
    }
  }
  if (hasWorkflows) addResumeTool(registry, app, session);
  return registry;
}

function toolMetaOf(exp: Class): ToolMeta | undefined {
  const component = componentOf(exp);
  return component?.kind === "tool" || component?.kind === "mcp-tool" ? component.meta : undefined;
}

const isToolHandler = (value: unknown): value is ToolHandler<unknown, unknown> =>
  isRecord(value) && typeof value.run === "function";

interface ExportedTool {
  readonly app: App;
  readonly exp: Class;
  readonly meta: ToolMeta;
}

function addTool(registry: ToolRegistry, exported: ExportedTool): void {
  const { app, exp, meta } = exported;
  const instance: unknown = app.hasTool(meta.name) ? app.resolve(exp) : undefined;
  if (!isToolHandler(instance)) {
    throw new Error(
      `@McpExpose exports ${exp.name}, which is not a tool of application "${app.name}"`,
    );
  }
  const tool = adapt(instance, meta);
  registry.tools.push({
    name: meta.name,
    description: meta.description || (meta.prompt ?? ""),
    inputSchema: objectSchema(meta.input),
    outputSchema: objectSchema(meta.output),
  });
  registry.handlers.set(meta.name, async (call) =>
    toolResult(
      await inMcpCallFrame({ app, type: exp, name: meta.name }, call, () =>
        tool.invoke(call.args, toolCallOf(call)),
      ),
    ),
  );
}

/** A call over MCP: its signal; nothing records a cost (there is no execution to bill). */
const toolCallOf = (call: McpCall): ToolInvocationContext => ({
  signal: call.signal,
  reportCost: () => undefined,
});

const toolResult = (output: ToolOutput<unknown>): CallToolResult =>
  // a mesh limit the tool met (#398) goes back with its facts: the caller's step fails with it
  output.kind === "error" && isMeshLimitError(output.cause)
    ? failureResult(output.cause)
    : output.kind === "ok" && isRecord(output.value)
      ? {
          content: [{ type: "text", text: renderToolResult(output) }],
          structuredContent: output.value,
        }
      : {
          content: [{ type: "text", text: renderToolResult(output) }],
          isError: output.kind === "error",
        };

/** An exported `@WorkflowStart` class: its declaration. */
const startOf = (exp: Class): WorkflowStartDeclaration | undefined => {
  const declaration = declarationOf(exp);
  return declaration?.kind === NodeKind.Start ? declaration : undefined;
};

const isStart = (exp: Class): boolean => startOf(exp) !== undefined;

/** The JSON schema of a start's input: its DTO's (a list or a map of fields takes any object). */
function startInputSchema(declaration: WorkflowStartDeclaration): ReturnType<typeof objectSchema> {
  const { input } = declaration.options;
  return typeof input === "function" ? objectSchema(input) : { type: "object" as const };
}

function addWorkflowStart(
  registry: ToolRegistry,
  app: App,
  exp: Class,
  session: McpSessionOptions,
): void {
  const declaration = startOf(exp);
  if (declaration === undefined) return;
  const { name, description } = declaration.options;
  registry.tools.push({
    name,
    description: description || `Run workflow starting at ${name}`,
    inputSchema: startInputSchema(declaration),
  });
  // the session's caller as the execution takes it: its peer is the transport's, not an option
  const caller = { ownerId: session.ownerId, tenant: session.tenant, execution: session.execution };
  registry.handlers.set(name, async (call) => {
    let reported: Record<string, string> | undefined;
    const answered = await guarded(async () => {
      // the call chain the envelope brought (#398): the execution's own calls carry it on
      const options = withInboundMesh<ExecutionOptions>(
        { ...caller, signal: call.signal },
        call.mesh,
      );
      // the app checks the payload against the start's input
      const result = await executeUnchecked(app, exp, call.args, options);
      reported = runReportMetaOf(app, call, result); // a trusted call's signed report (#398)
      return formatWorkflowOutput(result);
    });
    return reported === undefined ? answered : { ...answered, _meta: reported };
  });
}

function addResumeTool(registry: ToolRegistry, app: App, session: McpSessionOptions): void {
  registry.tools.push(RESUME_TOOL);
  registry.handlers.set(RESUME_TOOL.name, (call) =>
    guarded(async () => {
      const input = isRecord(call.args) ? call.args : {};
      if (typeof input.pauseId !== "string") throw new Error("pauseId must be a string");
      const { ownerId, tenant } = session;
      const options = { ownerId, tenantId: tenant?.tenantId, signal: call.signal };
      const request = { pauseId: input.pauseId, decision: parseDecision(input.decision) };
      const result = await app.resume(request, options);
      return formatWorkflowOutput(result);
    }),
  );
}

function formatWorkflowOutput(result: ExecutionOutput): unknown {
  if (result.status === ExecutionStatus.Paused) {
    return {
      status: "paused",
      threadId: result.threadId,
      message: "Workflow paused, requires resume.",
      pending: result.pending,
    };
  }
  return result.output ?? result;
}
