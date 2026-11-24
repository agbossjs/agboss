import type { Class } from "../components/injection.js";
import type { AssembledToolInterceptors } from "./assembly.js";

/**
 * The tool interceptors at run time (#384): each agent's chain per tool, its instances from the
 * application's container (created at start, so a missing dependency fails there).
 */

/** An interceptor's instance as the agent loop calls it: the catch-alls may be absent. */
export interface ToolInterceptorInstance {
  readonly beforeAnyTool?: (call: unknown) => unknown;
  readonly afterAnyTool?: (call: unknown) => unknown;
}

/** One interceptor of a chain: its name, its instance and which method serves the chain's tool. */
export interface RuntimeToolInterceptor {
  readonly name: string;
  readonly instance: ToolInterceptorInstance;
  /** The `@Tool` / `@McpTool` class the chain is for. */
  readonly toolType: Class;
  /** The names of the `@BeforeTool` / `@AfterTool` methods of this tool, if it has them. */
  readonly beforeMethod: string | undefined;
  readonly afterMethod: string | undefined;
}

/** An agent's chains: the interceptors of its calls to one tool, outer first. */
export type ToolInterceptorChains = (tool: string) => readonly RuntimeToolInterceptor[];

/** A workflow's tool interceptors as assembled (what `configHash` hashes), and one agent's chains. */
export interface ToolInterceptorRuntime extends AssembledToolInterceptors {
  readonly ofAgent: (agent: string) => ToolInterceptorChains;
}

const NO_CHAIN: readonly RuntimeToolInterceptor[] = [];

/** The runtime of a workflow's assembled interceptors; `resolve` gives a class's instance. */
export function toolInterceptorRuntimeOf(
  assembled: AssembledToolInterceptors | undefined,
  resolve: (cls: Class) => unknown,
): ToolInterceptorRuntime {
  const instanceOf = (cls: Class): ToolInterceptorInstance =>
    resolve(cls) as ToolInterceptorInstance;
  return {
    byAgent: assembled?.byAgent ?? new Map(),
    interceptors: assembled?.interceptors ?? [],
    toolTypes: assembled?.toolTypes ?? new Map(),
    ofAgent: (agent) => {
      const tools = assembled?.byAgent.get(agent);
      return (tool) => {
        const toolType = assembled?.toolTypes.get(tool);
        if (toolType === undefined) return NO_CHAIN;
        return (
          tools?.get(tool)?.map((loaded) => ({
            name: loaded.name,
            instance: instanceOf(loaded.type),
            toolType,
            beforeMethod: loaded.methods.before.get(toolType),
            afterMethod: loaded.methods.after.get(toolType),
          })) ?? NO_CHAIN
        );
      };
    },
  };
}
