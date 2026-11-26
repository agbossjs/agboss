import { recordOptionKeys } from "./option-keys.js";
import {
  CHANNEL_KEYS,
  INJECTABLE_KEYS,
  MCP_SERVER_KEYS,
  RAG_KEYS,
  TOOL_KEYS,
} from "./decorator-options.js";
import type { McpServerConfig } from "../config/mcp-server-config.js";
import type { RagScope } from "../rag/types.js";
import type { RagSource } from "../rag/rag-source.js";
import type { DtoClass } from "../dto/types.js";
import type { Bytes, Milliseconds } from "../units/index.js";
import type { Class, ResolvedAll, Token } from "./injection.js";
import type { McpServerClient, ServerTools } from "./mcp-client.js";
import { recordComponent } from "./metadata.js";
import { recordInjectAs, type InjectAs, type PortInstances } from "./injection.js";

/**
 * The shape of a tool (`@Tool`): `execute(input)` returns its output DTO, or a promise
 * of it. `@Tool({ input, output })` checks the method against its DTOs, so a tool class needs no
 * `implements`. `execute` gets only its input; the execution it runs in comes through
 * `deps: [ExecutionContext]` (#280).
 */
export interface ToolHandler<TInput, TOutput> {
  execute: (input: TInput) => TOutput | Promise<TOutput>;
}

/** `@Tool` classes: the ones with a `ToolHandler`-shaped `execute`. */
export type ToolHandlerClass = Class<ToolHandler<never, unknown>>;

/**
 * An `@ExternalTask` an agent asks through its tool loop (#712): a class with no `execute` — the
 * task is what its channel's side does, not code of the class. A class that does have `execute` is a
 * tool.
 */
export type ExternalTaskClass = Class<object>;

/** What an agent's `tools: [...]` takes: `@Tool` classes and external tasks (#712). */
export type AgentToolClass = ToolHandlerClass | ExternalTaskClass;

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
  /** The `@ToolApproval` this tool's calls wait for (#1307); none: its calls run without a pause. */
  readonly approval?: Class;
  /**
   * Whether the tool only reads (#860): it changes nothing outside — no write, no payment, no
   * message sent. An agent of a skill that answers with a direct A2A message (`A2AReply.Message`)
   * may call only such tools (`[a2a.message-skill-tool]`). Unset: it may change things.
   */
  readonly readOnly?: boolean;
  /** How long one call may run, with units: `timeout: seconds(5)` (default 30 s), at most 24 hours (`[limits.timeout-invalid]`, #1141). */
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

/** A tool: one class with an `execute` method, dependencies through the constructor. */
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
    recordOptionKeys(value, "Tool", options, TOOL_KEYS);
    recordComponent(value, { kind: "tool", meta: withDeps(options) });
    return value;
  };
}

/** The options of `@Injectable`. */
export interface InjectableOptions<
  D extends readonly Token[],
  TPorts extends InjectAs = readonly [],
> {
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: D;
  /**
   * The abstract ports (#1324) this class is the implementation of: a dependency on `Port` gets
   * it. Checked by the compiler — the class must be assignable to every port. List it in the
   * `services` of the `@Application` (all workflows) or of one `@Workflow` (that workflow only,
   * over the application's).
   */
  readonly injectAs?: TPorts;
}

/** A class the container creates for others (a judge, a client, a store's connection, …). */
export function Injectable<
  const D extends readonly Token[] = [],
  const TPorts extends InjectAs = readonly [],
>(options: InjectableOptions<D, TPorts> = {}) {
  return <C extends new (...args: ResolvedAll<D>) => PortInstances<TPorts>>(value: C): C => {
    recordOptionKeys(value, "Injectable", options, INJECTABLE_KEYS);
    recordComponent(value, { kind: "injectable", meta: { deps: options.deps ?? [] } });
    recordInjectAs(value, options.injectAs);
    return value;
  };
}

/** What `@McpServer` records of its class: the name, the declared tools and the connection. */
export type McpServerOptions<TTools extends ServerTools> = {
  /** Clean identifier of the server (`catalog`, `playwright`): no kind suffix. */
  readonly name: string;
  /** The server tools the application calls, which type the class's `call`. */
  readonly tools: TTools;
} & McpServerConfig;

/**
 * An MCP server the application connects to: its connection and the server tools it calls
 * (`tools`), which type the class's `call` (`extends McpServerClient<typeof tools>`). A tool, an
 * action or a service lists the class in its `deps`; the server is connected when the application
 * starts.
 */
export function McpServer<
  const TTools extends ServerTools,
  const TPorts extends InjectAs = readonly [],
>(options: McpServerOptions<TTools> & { readonly injectAs?: TPorts }) {
  return <C extends new () => McpServerClient<TTools> & PortInstances<TPorts>>(value: C): C => {
    recordOptionKeys(value, "McpServer", options, MCP_SERVER_KEYS);
    const { name, tools, injectAs, ...config } = options;
    recordComponent(value, { kind: "mcp-server", meta: { name, config, tools } });
    recordInjectAs(value, injectAs);
    return value;
  };
}

/** What `@Rag` takes. */
export interface RagOptions<D extends readonly Token[] = readonly Token[]> {
  readonly name: string;
  readonly description: string;
  /** Whose content it serves: one corpus for all, each tenant's, each owner's, or a custom scope. */
  readonly scope: RagScope;
  /** What the agent gets per retrieval. */
  readonly topK: number;
  /** A `@RagReranker` class: fetch its `candidates`, keep `topK`. */
  readonly reranker?: Class;
  readonly deps?: D;
}

/**
 * A knowledge base: a class extending `RagSource`. `topK` (passages per retrieval, or what the agent
 * keeps after reranking) and `scope` are required — there is no default, so content many readers
 * share is always an explicit choice (`RagScope.Shared`, `Tenant`, `Owner`, `Custom`; else
 * `[rag.scope-required]` at assembly). `reranker` is a `@RagReranker` class (it fetches `candidates`,
 * the reranker keeps `topK`). Agents list it in `rag: [CompanyDocs]`; a `@Tool` or an `@Action`
 * injects it (`deps: [CompanyDocs]`) and calls `search(query)`.
 */
export function Rag<const D extends readonly Token[] = []>(options: RagOptions<D>) {
  return <C extends new (...args: ResolvedAll<D>) => RagSource>(value: C): C => {
    recordOptionKeys(value, "Rag", options, RAG_KEYS);
    recordComponent(value, { kind: "rag", meta: withDeps(options) });
    return value;
  };
}

/** What `@Channel({ … })` takes: the channel's name and description, and its `deps`. */
export interface ChannelOptions<D extends readonly Token[] = readonly Token[]> {
  readonly name: string;
  readonly description?: string;
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: D;
  /** The `@ToolApproval` or `@ExternalTask` this channel serves (#1307): its transport. */
  readonly target: Class;
  /**
   * How long a closed pause of this channel is kept, for duplicate webhook and click detection
   * (#1307): more than the execution lease (30 s).
   */
  readonly ttl: Milliseconds;
  /** How long one call of the channel may run (#1307); default 30 s. */
  readonly timeout?: Milliseconds;
}

/**
 * A channel (#267, #1307): the transport of one `@ToolApproval` or `@ExternalTask` — it `send`s a
 * pause to a person or a system, and may hear of what happened to it (`onPause*`). The container
 * creates it with its `deps`; the execution comes through an injected `ExecutionContext`. One
 * instance per application, shared by all workflows.
 */
export function Channel<const D extends readonly Token[] = []>(options: ChannelOptions<D>) {
  // any target's `send` (`ChannelHandler<Target>`): the ask's type is the target's
  return <C extends new (...args: ResolvedAll<D>) => { send(ask: never): unknown }>(
    value: C,
  ): C => {
    recordOptionKeys(value, "Channel", options, CHANNEL_KEYS);
    recordComponent(value, { kind: "channel", meta: withDeps(options) });
    return value;
  };
}

export {
  GuardrailSide,
  InputGuardrail,
  OutputGuardrail,
  type CodeGuardrailTextOptions,
  type GuardrailComputedOptions,
  type GuardrailRefusal,
  type GuardrailTextOptions,
} from "./policy-decorators.js";
