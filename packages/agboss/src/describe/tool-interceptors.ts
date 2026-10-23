import type { AssembledToolInterceptors } from "../tool-interceptors/assembly.js";
import type { AssembledWorkflow } from "../workflow.js";

/**
 * Each tool interceptor (#384): which of its methods it has and the agents' tools it intercepts —
 * `tenant-scope-tool-interceptor — before · on search-agent: greenhouse-jobs-tool, lever-jobs-tool`.
 */

const hooksLabel = ({ before, after }: { before: boolean; after: boolean }): string =>
  [before ? "before" : "", after ? "after" : ""].filter((hook) => hook !== "").join(", ");

/** The agents' tools one interceptor intercepts: `agent: tool, tool; agent: tool`. */
function usersOf(assembled: AssembledToolInterceptors, type: unknown): string {
  const users = [...assembled.byAgent].flatMap(([agent, tools]) => {
    const names = [...tools]
      .filter(([, chain]) => chain.some((interceptor) => interceptor.type === type))
      .map(([tool]) => tool);
    return names.length === 0 ? [] : [`${agent}: ${names.join(", ")}`];
  });
  return users.join("; ") || "none";
}

export function toolInterceptorLines(bundle: AssembledWorkflow): string[] {
  const assembled = bundle.toolInterceptors;
  if (assembled === undefined || assembled.interceptors.length === 0)
    return ["tool interceptors none"];
  return [
    "tool interceptors",
    ...assembled.interceptors.map(
      (interceptor) =>
        `  ${interceptor.name} — ${hooksLabel(interceptor.hooks)} · on ${usersOf(assembled, interceptor.type)}`,
    ),
  ];
}

/** An agent's interceptor chains by tool (#384): `{}` when it has none, so its snapshot keeps its shape. */
export function toolInterceptorsAt(bundle: AssembledWorkflow, agent: string): object {
  const chains = [...(bundle.toolInterceptors?.byAgent.get(agent) ?? [])].filter(
    ([, chain]) => chain.length > 0,
  );
  if (chains.length === 0) return {};
  const names = chains.map(([tool, chain]) => [tool, chain.map((i) => i.name)] as const);
  return { toolInterceptors: Object.fromEntries(names) };
}
