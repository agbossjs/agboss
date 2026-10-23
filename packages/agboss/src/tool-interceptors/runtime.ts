import type { Class } from "../components/injection.js";
import type { AssembledToolInterceptors } from "./assembly.js";

/**
 * The tool interceptors at run time (#384): each agent's chain per tool, its instances from the
 * application's container (created at start, so a missing dependency fails there).
 */

/** An interceptor's instance as the agent loop calls it: either method may be absent. */
export interface ToolInterceptorInstance {
  readonly beforeToolCall?: (call: unknown) => unknown;
  readonly afterToolCall?: (call: unknown) => unknown;
}

/** One interceptor of a chain: its name and its instance. */
export interface RuntimeToolInterceptor {
  readonly name: string;
  readonly instance: ToolInterceptorInstance;
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
    ofAgent: (agent) => {
      const tools = assembled?.byAgent.get(agent);
      return (tool) =>
        tools
          ?.get(tool)
          ?.map((loaded) => ({ name: loaded.name, instance: instanceOf(loaded.type) })) ?? NO_CHAIN;
    },
  };
}
