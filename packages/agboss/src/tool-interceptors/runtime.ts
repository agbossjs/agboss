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
  /** The `@Tool` class the chain is for; none for a call of a tool nobody resolved. */
  readonly toolType: Class | undefined;
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
    agentLevel: assembled?.agentLevel ?? new Map(),
    ofAgent: (agent) => {
      const tools = assembled?.byAgent.get(agent);
      const types = assembled?.toolTypes.get(agent);
      // fail closed: a call of a tool that resolves to no class still meets the catch-all hooks of
      // the agent's interceptors, never an empty chain
      const catchAlls = (assembled?.agentLevel.get(agent) ?? []).map(
        (loaded): RuntimeToolInterceptor => ({
          name: loaded.name,
          instance: instanceOf(loaded.type),
          toolType: undefined,
          beforeMethod: undefined,
          afterMethod: undefined,
        }),
      );
      return (tool) => {
        const toolType = types?.get(tool);
        const chain = tools?.get(tool);
        if (toolType === undefined || chain === undefined)
          return catchAlls.length === 0 ? NO_CHAIN : catchAlls;
        return chain.map((loaded) => ({
          name: loaded.name,
          instance: instanceOf(loaded.type),
          toolType,
          beforeMethod: loaded.methods.before.get(toolType),
          afterMethod: loaded.methods.after.get(toolType),
        }));
      };
    },
  };
}
