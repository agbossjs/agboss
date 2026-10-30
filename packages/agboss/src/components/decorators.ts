import type { McpServerConfig } from "../config/types.js";
import type { RagConnector } from "../rag/types.js";
import type { DtoClass } from "../dto/types.js";
import type { Bytes, Milliseconds } from "../units/index.js";
import type { ChannelMeta } from "./meta-types.js";
import type { Class, ResolvedAll, Token } from "./injection.js";
import type { McpServerClient, ServerTools } from "./mcp-client.js";
import { recordComponent } from "./metadata.js";
import { declareEnvironmentFields, type EnvironmentFields } from "../environments/contract.js";

/**
 * The contract of a tool (`@Tool`, `@McpTool`): `implements ToolHandler<OrderQuery, OrderStatus>` — its
 * input and output DTOs (classes from `@agboss/core/dto`). `run` gets only its input; the execution it
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
  /** How long one call may run, with units: `timeout: seconds(5)` (default 30 s). */
  readonly timeout?: Milliseconds;
  /**
   * What a model reads of one result at most, in bytes of UTF-8: `maxResultSize: kilobytes(256)`
   * (#336) — longer is cut with a marker; default `defaults.tools.maxResultSize`, else 128 KB.
   */
  readonly maxResultSize?: Bytes;
  /**
   * `@ToolInterceptor` classes of this tool's calls (#384), after its application's, workflow's and
   * agent's: lists add up.
   */
  readonly toolInterceptors?: readonly Class[];
  /** Inherited tool interceptors removed for this tool's calls (#384). */
  readonly excludeToolInterceptors?: readonly Class[];
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

/** The options of `@Injectable`. */
export interface InjectableOptions<D extends readonly Token[]> {
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: D;
  /**
   * The fields of the environment contract the class reads (#511) — a store's connection:
   * `{ postgresUrl: EnvironmentField.Secret, postgresPoolSize: EnvironmentField.OptionalInteger }`.
   * An application that lists it, or a class whose `deps` reach it, fails assembly with
   * `[environment.missing-field]` when its contract lacks a required one.
   */
  readonly environmentFields?: EnvironmentFields;
}

/** A class the container creates for others (a judge, a client, a store's connection, …). */
export function Injectable<const D extends readonly Token[] = []>(
  options: InjectableOptions<D> = {},
) {
  return <C extends new (...args: ResolvedAll<D>) => object>(value: C): C => {
    recordComponent(value, { kind: "injectable", meta: { deps: options.deps ?? [] } });
    if (options.environmentFields !== undefined) {
      declareEnvironmentFields(value, options.environmentFields);
    }
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

export {
  GuardrailSide,
  InputGuardrail,
  OutputGuardrail,
  type CodeGuardrailComputedOptions,
  type CodeGuardrailTextOptions,
  type GuardrailComputedOptions,
  type GuardrailRefusal,
  type GuardrailTextOptions,
} from "./policy-decorators.js";
export {
  BindTool,
  getBoundTools,
  type BindToolOptions,
  type BoundToolConfig,
} from "./bind-tool.js";
