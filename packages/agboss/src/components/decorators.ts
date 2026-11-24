import type { McpServerConfig } from "../config/mcp-server-config.js";
import type { RagScope } from "../rag/types.js";
import type { RagSource } from "../rag/rag-source.js";
import type { DtoClass } from "../dto/types.js";
import type { Bytes, Milliseconds, WorkingDuration } from "../units/index.js";
import type { Class, ResolvedAll, Token } from "./injection.js";
import type { McpServerClient, ServerTools } from "./mcp-client.js";
import { ComponentError, recordComponent } from "./metadata.js";
import { recordInjectAs, type InjectAs, type PortInstances } from "./injection.js";
import { declareEnvironmentFields, type EnvironmentFields } from "../environments/contract.js";

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
 * A question role an agent asks through its tool loop (#712): a `@ChannelRole({ ask, answer })`
 * class — what its channels `send`; an approval role there fails assembly.
 */
export type QuestionRoleClass = Class<{ send(ask: never): Promise<unknown> }>;

/** What an agent's `tools: [...]` takes: `@Tool` classes and question roles (#712). */
export type AgentToolClass = ToolHandlerClass | QuestionRoleClass;

/**
 * `@Tool({ approval })` is the approval its calls wait for (#1307): recorded as the channel the
 * runtime reads, `approval` kept beside it. Both → a mistake, said once.
 */
function approvalAsChannel<O extends { readonly channel?: Class; readonly approval?: Class }>(
  options: O,
): O {
  if (options.approval === undefined) return options;
  if (options.channel !== undefined) {
    throw new ComponentError({
      message:
        "[tool.approval-and-channel] a tool names its approval with approval — channel is its old spelling; give one of them",
    });
  }
  return { ...options, channel: options.approval };
}

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
  readonly channel?: Class;
  /**
   * The `@ToolApproval` this tool's calls wait for (#1307): the new name of `channel`; one of the
   * two, never both.
   */
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
   * How long the approval of one call waits for its answer (#941): `expiresIn: hours(4)`, over its
   * channel role's; at least `seconds(1)`; `workingHours(4)` counts the calendar's working time (#944). Only with `channel`. At the deadline the channel's
   * `onPauseExpired` decides, or the agent step fails with `PauseExpiredError`.
   */
  readonly expiresIn?: Milliseconds | WorkingDuration;
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
    recordComponent(value, { kind: "tool", meta: withDeps(approvalAsChannel(options)) });
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
  /**
   * The fields of the environment contract the class reads (#511) — a store's connection:
   * `{ postgresUrl: EnvironmentField.secret(), postgresPoolSize: EnvironmentField.integer({ optional: true }) }`.
   * An application that lists it, or a class whose `deps` reach it, fails assembly with
   * `[environment.missing-field]` when its contract lacks a required one.
   */
  readonly environmentFields?: EnvironmentFields;
}

/** A class the container creates for others (a judge, a client, a store's connection, …). */
export function Injectable<
  const D extends readonly Token[] = [],
  const TPorts extends InjectAs = readonly [],
>(options: InjectableOptions<D, TPorts> = {}) {
  return <C extends new (...args: ResolvedAll<D>) => PortInstances<TPorts>>(value: C): C => {
    recordComponent(value, { kind: "injectable", meta: { deps: options.deps ?? [] } });
    recordInjectAs(value, options.injectAs);
    if (options.environmentFields !== undefined) {
      declareEnvironmentFields(value, options.environmentFields);
    }
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
    const { name, tools, injectAs, ...config } = options;
    recordComponent(value, { kind: "mcp-server", meta: { name, config, tools } });
    recordInjectAs(value, injectAs);
    return value;
  };
}

/**
 * A knowledge base: a class extending `RagSource`. `topK` (passages per retrieval, or what the agent
 * keeps after reranking) and `scope` are required — there is no default, so content many readers
 * share is always an explicit choice (`RagScope.Shared`, `Tenant`, `Owner`, `Custom`; else
 * `[rag.scope-required]` at assembly). `reranker` is a `@RagReranker` class (it fetches `candidates`,
 * the reranker keeps `topK`). Agents list it in `rag: [CompanyDocs]`; a `@Tool` or an `@Action`
 * injects it (`deps: [CompanyDocs]`) and calls `search(query)`.
 */
export function Rag<const D extends readonly Token[] = []>(options: {
  readonly name: string;
  readonly description: string;
  /** Whose content it serves: one corpus for all, each tenant's, each owner's, or a custom scope. */
  readonly scope: RagScope;
  /** What the agent gets per retrieval. */
  readonly topK: number;
  /** A `@RagReranker` class: fetch its `candidates`, keep `topK`. */
  readonly reranker?: Class;
  readonly deps?: D;
}) {
  return <C extends new (...args: ResolvedAll<D>) => RagSource>(value: C): C => {
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
  /**
   * The `@ToolApproval` or `@ExternalTask` this channel serves (#1307) — in place of `extends` the
   * role. With it, `ttl` is required.
   */
  readonly target?: Class;
  /**
   * How long a closed pause of this channel is kept, for duplicate webhook and click detection
   * (#1307): more than the execution lease (30 s). Required with `target`.
   */
  readonly ttl?: Milliseconds;
  /** How long one call of the channel may run (#1307); default 30 s. */
  readonly timeout?: Milliseconds;
}

/** `@Channel({ target, ttl })`: a channel bound to its pause target (#1307). */
export interface TargetChannelOptions<
  D extends readonly Token[] = readonly Token[],
> extends ChannelOptions<D> {
  readonly target: Class;
  readonly ttl: Milliseconds;
}

/**
 * A channel (#267): a role's implementation (`extends` a `@ChannelRole` class), or a concrete
 * channel a tool names as is. The container creates it with its `deps`; the execution comes
 * through an injected `ExecutionContext`. One instance per application, shared by all workflows.
 */
export function Channel<const D extends readonly Token[] = []>(
  options: TargetChannelOptions<D>,
): <C extends new (...args: ResolvedAll<D>) => { send(ask: never): unknown }>(value: C) => C;
export function Channel<const D extends readonly Token[] = []>(
  options: ChannelOptions<D> & { readonly target?: never; readonly ttl?: never },
): <C extends new (...args: ResolvedAll<D>) => { send(ask: never): Promise<unknown> }>(
  value: C,
) => C;
export function Channel<const D extends readonly Token[] = []>(options: ChannelOptions<D>) {
  // any role's `send` (`ChannelHandler<Role>`): the ask's type is the role's, checked by `implements`
  return <C extends new (...args: ResolvedAll<D>) => { send(ask: never): unknown }>(
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
  type CodeGuardrailTextOptions,
  type GuardrailComputedOptions,
  type GuardrailRefusal,
  type GuardrailTextOptions,
} from "./policy-decorators.js";
