import type { DtoClass } from "../dto/types.js";
import type { ToolInvocationContext, ToolOutput } from "../tools/index.js";

/** A server tool as a workflow uses it: the DTOs of its arguments and its result. */
export interface ServerTool {
  readonly input: DtoClass;
  readonly output: DtoClass;
}

/** The arguments / the result of a declared server tool. */
type ArgumentsOf<TTool extends ServerTool> = InstanceType<TTool["input"]>;
type ResultOf<TTool extends ServerTool> = InstanceType<TTool["output"]>;
export type ServerTools = Readonly<Record<string, ServerTool>>;

/** What `call` goes through: the framework's facade of one server tool (validation, connection). */
export interface ServerToolCallable {
  invoke(raw: unknown, ctx: ToolInvocationContext): Promise<ToolOutput<unknown>>;
}

const noCost = (): void => undefined;

/**
 * Standard implementation of an MCP server's client: `extends McpServerClient<Tools>` gives the class a
 * typed `call` — the tool name and its arguments are checked by the compiler, validated and parsed by
 * the declared DTOs. The framework creates the instance and connects it; inject it like any dependency.
 */
export abstract class McpServerClient<TTools extends ServerTools> {
  /** Type only (not emitted): the declared tools, so `ToolsOf<Server>` can read them. */
  declare readonly declaredTools?: TTools;

  #tools: ReadonlyMap<string, ServerToolCallable> = new Map();

  /** Framework wiring: the connected tools of this server. */
  attachServerTools(tools: ReadonlyMap<string, ServerToolCallable>): void {
    this.#tools = tools;
  }

  async call<K extends keyof TTools & string>(
    name: K,
    args: ArgumentsOf<TTools[K]>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ResultOf<TTools[K]>> {
    const tool = this.#tools.get(name);
    if (tool === undefined) throw new Error(`MCP tool "${name}" is not declared on this server`);
    const result = await tool.invoke(args, { signal, reportCost: noCost });
    if (result.kind === "error") throw new Error(result.message);
    // the facade validated the value against the declared output DTO
    return result.value as ResultOf<TTools[K]>;
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
