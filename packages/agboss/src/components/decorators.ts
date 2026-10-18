import type { McpServerConfig } from "../config/types.js";
import type { RagConnector } from "../rag/types.js";
import type { DtoClass } from "../dto/types.js";
import type { ChannelMeta } from "./meta-types.js";
import type { Class, ResolvedAll, Token } from "./injection.js";
import type { McpServerClient, ServerTools } from "./mcp-client.js";
import { recordComponent } from "./metadata.js";
import type { Guardrail } from "./policy-decorators.js";

/**
 * The contract of a tool (`@Tool`, `@McpTool`): `implements ToolHandler<OrderQuery, OrderStatus>` — its
 * input and output DTOs (classes from `agboss/dto`). `run` gets only its input; the execution it
 * runs in comes through `deps: [ExecutionContext]` (#280).
 */
export interface ToolHandler<TInput, TOutput> {
  run: (input: TInput) => Promise<TOutput>;
}

/** What `tools: [...]` takes: `@Tool` / `@McpTool` classes, the ones implementing `ToolHandler`. */
export type ToolHandlerClass = Class<ToolHandler<never, unknown>>;

/** A decorator's options as recorded: `deps` always present. */
const withDeps = <O extends { readonly deps?: readonly Token[] }>(options: O) => ({
  ...options,
  deps: options.deps ?? [],
});

export interface ToolOptions<
  In extends DtoClass,
  Out extends DtoClass,
  D extends readonly Token[],
> {
  readonly name: string;
  readonly description: string;
  readonly prompt?: string;
  readonly promptUrls?: readonly string[];
  readonly channel?: Class;
  readonly timeoutMs?: number;
  readonly guardrails?: readonly Class<Guardrail>[];
  readonly overrideGuardrails?: readonly Class<Guardrail>[];
  readonly disableGuardrails?: readonly Class<Guardrail>[];
  readonly input: In;
  readonly output: Out;
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: D;
}

/** A tool: one class implementing `ToolHandler`, dependencies through the constructor. */
export function Tool<
  In extends DtoClass,
  Out extends DtoClass,
  const D extends readonly Token[] = [],
>(options: ToolOptions<In, Out, D>) {
  return <
    C extends new (...args: ResolvedAll<D>) => ToolHandler<InstanceType<In>, InstanceType<Out>>,
  >(
    value: C,
  ): C => {
    recordComponent(value, { kind: "tool", meta: withDeps(options) });
    return value;
  };
}

/** A class the container creates for others (a judge, a client, …). */
export function Injectable<const D extends readonly Token[] = []>(
  options: { readonly deps?: D } = {},
) {
  return <C extends new (...args: ResolvedAll<D>) => object>(value: C): C => {
    recordComponent(value, { kind: "injectable", meta: { deps: options.deps ?? [] } });
    return value;
  };
}

/**
 * An MCP server the workflow connects to: its launch config and the server tools the workflow uses
 * (`tools`), which type the class's `call` (`extends McpServerClient<typeof tools>`).
 */
export function McpServer<const TTools extends ServerTools>(
  options: { readonly name: string; readonly tools: TTools } & McpServerConfig,
) {
  return <C extends new () => McpServerClient<TTools>>(value: C): C => {
    const { name, tools, ...config } = options;
    recordComponent(value, { kind: "mcp-server", meta: { name, config, tools } });
    return value;
  };
}

/**
 * A tool backed by an MCP server: like `@Tool` (implements `ToolHandler`, dependencies through the
 * constructor) with its server's client among `deps`; `run` calls the server's tools through it.
 */
export function McpTool<
  In extends DtoClass,
  Out extends DtoClass,
  const D extends readonly Token[] = [],
>(options: ToolOptions<In, Out, D> & { readonly server: Class }) {
  return <
    C extends new (...args: ResolvedAll<D>) => ToolHandler<InstanceType<In>, InstanceType<Out>>,
  >(
    value: C,
  ): C => {
    const { server, ...tool } = options;
    recordComponent(value, { kind: "mcp-tool", meta: { ...tool, deps: tool.deps ?? [], server } });
    return value;
  };
}

/**
 * A knowledge base: a class implementing `RagConnector`. `topK` (passages per retrieval) is required —
 * there is no default. Agents bind it with a required `mode`: `rag: [{ use: CompanyDocs, mode: "tool" }]`.
 */
export function Rag<const D extends readonly Token[] = []>(options: {
  readonly name: string;
  readonly description: string;
  readonly topK: number;
  readonly prompt?: string;
  readonly promptUrls?: readonly string[];
  readonly deps?: D;
}) {
  return <C extends new (...args: ResolvedAll<D>) => RagConnector>(value: C): C => {
    recordComponent(value, { kind: "rag", meta: withDeps(options) });
    return value;
  };
}

/**
 * A channel (#267): a role's implementation (`extends` a `@ChannelRole` class), or a concrete
 * channel a tool names as is. The container creates it with its `deps`; the execution comes
 * through an injected `ExecutionContext`. One instance per application, shared by all workflows.
 */
export function Channel<const D extends readonly Token[] = []>(
  options: ChannelMeta & { readonly deps?: D },
) {
  // any role's `send` (`ChannelHandler<Role>`): the ask's type is the role's, checked by `implements`
  return <C extends new (...args: ResolvedAll<D>) => { send(ask: never): Promise<unknown> }>(
    value: C,
  ): C => {
    recordComponent(value, { kind: "channel", meta: withDeps(options) });
    return value;
  };
}

export { Guardrail, type GuardrailContext } from "./policy-decorators.js";
export {
  BindTool,
  getBoundTools,
  type BindToolOptions,
  type BoundToolConfig,
} from "./bind-tool.js";
