import { createHash } from "node:crypto";
import type { DtoClass } from "../dto/types.js";
import {
  ToolTimeoutError,
  withCallIdentity,
  type ToolInvocationContext,
  type ToolOutput,
} from "../tools/index.js";
import { McpError } from "../core/error-families/remote-errors.js";
import { AGBossError } from "../core/errors.js";
import { currentFrame } from "../flow/context/frame.js";
import { serviceUsageOf } from "./spend-recorder.js";
import { systemClock, timeoutOn } from "../infrastructure/clock.js";
import { checkedTimer, MAX_TIMEOUT } from "../units/timer-limits.js";
import { usd, type Milliseconds, type Usd } from "../units/index.js";
import { ComponentError, componentOf } from "./metadata.js";

/**
 * A server tool as a workflow uses it: the DTO of its arguments (none for a tool without any) and
 * of its result.
 */
export interface ServerTool {
  readonly input?: DtoClass;
  readonly output: DtoClass;
}

/** The arguments of a declared server tool: `undefined` for a tool that declares no `input`. */
export type ArgumentsOf<TTool extends ServerTool> = TTool extends {
  readonly input: infer TInput extends DtoClass;
}
  ? InstanceType<TInput>
  : undefined;
/** The result of a declared server tool. */
export type ResultOf<TTool extends ServerTool> = InstanceType<TTool["output"]>;
export type ServerTools = Readonly<Record<string, ServerTool>>;

/** What one `McpServerClient.call` may be given besides its arguments. */
export interface McpCallOptions {
  /**
   * Inside one step, a second call of the same server tool needs its own key: each call is one
   * outbound call, and its identity is made of the step, the server, the tool and this key
   * (1–40 letters, digits, ".", "_" or "-").
   */
  readonly key?: string;
  /** Ends the call (with the signal's reason). Default: the running step's own signal. */
  readonly signal?: AbortSignal;
  /** Bounds the call further than the server's `timeout` does: the earlier of the two wins. */
  readonly timeout?: Milliseconds;
}

/** The arguments `call` takes after the tool's name: the options alone when the tool has no input. */
export type McpCallArguments<TTool extends ServerTool> =
  ArgumentsOf<TTool> extends undefined
    ? [options?: McpCallOptions]
    : [args: ArgumentsOf<TTool>, options?: McpCallOptions];

/** What `call` goes through: the framework's facade of one server tool (validation, connection). */
export interface ServerToolCallable {
  invoke(raw: unknown, ctx: ToolInvocationContext): Promise<ToolOutput<unknown>>;
}

/** What the framework knows of a connected server: its name and the bounds of its calls. */
export interface ServerWiring {
  readonly name: string;
  readonly timeout?: Milliseconds | undefined;
  readonly costPerCall?: Usd | undefined;
  readonly maxConcurrentCalls?: number | undefined;
}

const noCost = (): void => undefined;

/** The name a call of one server tool is charged under, in the cost report. */
const chargeServiceOf = (server: string): string => `mcp:${server}`;

/** A call's key: 1–40 letters, digits, ".", "_" or "-", a letter or digit first. */
const CALL_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u;

/** Lets at most `limit` calls through at once; the rest wait their turn, in order. */
class CallGate {
  readonly #waiting: (() => void)[] = [];
  #running = 0;

  constructor(private readonly limit: number) {}

  async enter(): Promise<() => void> {
    if (this.#running >= this.limit) {
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
      });
    } else {
      this.#running += 1;
    }
    return () => {
      const next = this.#waiting.shift();
      if (next === undefined) this.#running -= 1;
      else next();
    };
  }
}

/**
 * The identity of one call (`_meta.callId` of an AGBoss server): made of the step's idempotency
 * key, the server, the tool and the call's `key` — so several calls of one step never collide, and a
 * step that runs again makes the same ones. `undefined` outside a step.
 */
export function callIdOf(
  server: string,
  tool: string,
  key: string | undefined,
): string | undefined {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed()) return undefined;
  return createHash("sha256")
    .update([frame.step.idempotencyKey, server, tool, key ?? ""].join("\u0000"))
    .digest("hex");
}

/** The signal a call runs under — its own, else the step's — and the timer of its `timeout`. */
function boundOf(
  where: string,
  options: McpCallOptions | undefined,
): { readonly signal: AbortSignal; readonly release: () => void } {
  const frame = currentFrame();
  const stepSignal = frame === undefined || frame.isClosed() ? undefined : frame.execution.signal;
  const outer = options?.signal ?? stepSignal ?? new AbortController().signal;
  if (options?.timeout === undefined) return { signal: outer, release: () => undefined };
  const timeout = checkedTimer(`${where}: call timeout`, options.timeout, MAX_TIMEOUT);
  const timer = timeoutOn(systemClock, timeout, () => new ToolTimeoutError({ timeout }));
  return { signal: AbortSignal.any([outer, timer.signal]), release: timer.release };
}

/**
 * Standard implementation of an MCP server's client: `extends McpServerClient<Tools>` gives the class a
 * typed `call` — the tool name and its arguments are checked by the compiler, validated and parsed by
 * the declared DTOs. The framework creates the instance and connects it; inject it like any dependency.
 * A call without a `signal` ends with the running step; one that fails throws an `McpError`.
 */
export abstract class McpServerClient<TTools extends ServerTools> {
  /** Type only (not emitted): the declared tools, so `ToolsOf<Server>` can read them. */
  declare readonly declaredTools?: TTools;

  #tools: ReadonlyMap<string, ServerToolCallable> = new Map();
  #wiring: ServerWiring | undefined;
  #gate: CallGate | undefined;

  /** @internal Framework wiring: the connected tools of this server. */
  attachServerTools(tools: ReadonlyMap<string, ServerToolCallable>): void {
    this.#tools = tools;
  }

  /** @internal Framework wiring: the server's name and the bounds of its calls. */
  attachServer(wiring: ServerWiring): void {
    const limit = wiring.maxConcurrentCalls;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new ComponentError({
        message: `[mcp.max-concurrent-calls-invalid] ${wiring.name}: maxConcurrentCalls is ${String(limit)}, not a whole number from 1`,
      });
    }
    // a price that is no amount (negative, NaN, Infinity) fails at assembly, never after a call ran
    if (wiring.costPerCall !== undefined) usd(wiring.costPerCall);
    this.#wiring = wiring;
    this.#gate = limit === undefined ? undefined : new CallGate(limit);
  }

  /**
   * Headers added to every request of an HTTP server, read per request (a fresh token): over the
   * declared `headers`. Override in a subclass; the framework's own headers are never replaced.
   */
  protected getHeaders(): Record<string, string> | Promise<Record<string, string>> {
    return {};
  }

  /** @internal Framework wiring: the dynamic headers of one request. */
  async headersOfRequest(): Promise<Record<string, string>> {
    return await this.getHeaders();
  }

  async call<K extends keyof TTools & string>(
    name: K,
    ...rest: McpCallArguments<TTools[K]>
  ): Promise<ResultOf<TTools[K]>> {
    const tool = this.#tools.get(name);
    if (tool === undefined) throw new McpError.MethodNotFound();
    const takesInput = this.#declaredToolOf(name)?.input !== undefined;
    const [args, options] = (takesInput ? rest : [undefined, rest[0]]) as [
      unknown,
      McpCallOptions | undefined,
    ];
    const key = options?.key;
    if (key !== undefined && !CALL_KEY.test(key)) throw new McpError.Contract();
    const release = await this.#gate?.enter();
    try {
      return (await this.#called(name, tool, args, options)) as ResultOf<TTools[K]>;
    } finally {
      release?.();
    }
  }

  /** The tool as the class declares it; absent for a stub made of handlers only. */
  #declaredToolOf(name: string): ServerTool | undefined {
    const component = componentOf(this.constructor);
    return component?.kind === "mcp-server" ? component.meta.tools[name] : undefined;
  }

  async #called(
    name: string,
    tool: ServerToolCallable,
    args: unknown,
    options: McpCallOptions | undefined,
  ): Promise<unknown> {
    const server = this.#wiring?.name ?? this.constructor.name;
    const bound = boundOf(`${server}.${name}`, options);
    try {
      const callId = callIdOf(server, name, options?.key);
      const result = await withCallIdentity({ callId }, () =>
        tool.invoke(args ?? {}, { signal: bound.signal, reportCost: noCost }),
      );
      // a failure that is already an AGBoss error (a mesh limit, a tool timeout, a lost lease)
      // passes as it is: the step that called fails with it
      if (result.kind === "error") throw this.#failureOf(result.cause);
      this.#charge(server, callId);
      // the facade validated the value against the declared output DTO
      return result.value;
    } finally {
      bound.release();
    }
  }

  /** The error of a failed call: an AGBoss error as it is, else an `McpError` — never the server's text. */
  #failureOf(cause: unknown): AGBossError {
    if (cause instanceof AGBossError) return cause;
    // no cause: the arguments or the result broke the declared DTOs; a cause: the server or its wire failed
    return cause === undefined ? new McpError.Contract() : new McpError.Unavailable();
  }

  /** What the call cost by contract, charged to the step under the call's own ledger identity. */
  #charge(server: string, callId: string | undefined): void {
    const price = this.#wiring?.costPerCall;
    if (price === undefined) return;
    const cost = usd(price);
    if (cost === 0 || callId === undefined) return;
    currentFrame()?.services.reportUsage?.({
      ...serviceUsageOf({ service: chargeServiceOf(server), cost }),
      ledgerKey: { id: `mcp:${callId}:cost`, madeAt: systemClock.now() },
    });
  }
}

/** A handler per declared server tool: its arguments in, its result out (stubs, tests). */
export type ServerToolHandlers<TTools extends ServerTools> = {
  readonly [K in keyof TTools]?: (args: ArgumentsOf<TTools[K]>) => Promise<ResultOf<TTools[K]>>;
};

/** The tools a server class declares (`extends McpServerClient<Tools>`). */
export type ToolsOf<TServer> = TServer extends { readonly declaredTools?: infer TTools }
  ? NonNullable<TTools>
  : never;

/** A server instance answered by `handlers` — for testing MCP tools with `new`, no process. */
export function mcpServerStub<TServer extends McpServerClient<ServerTools>>(
  server: new () => TServer,
  handlers: ServerToolHandlers<ToolsOf<TServer>>,
): TServer {
  const instance = new server();
  const entries = Object.entries(handlers).flatMap(([name, handler]) => {
    if (handler === undefined) return [];
    // one handler per declared tool; at this boundary its argument and result are plain data
    const call = handler as (args: unknown) => Promise<unknown>;
    const callable: ServerToolCallable = {
      invoke: async (raw) => ({ kind: "ok", value: await call(raw) }),
    };
    return [[name, callable] as const];
  });
  instance.attachServerTools(new Map(entries));
  return instance;
}
