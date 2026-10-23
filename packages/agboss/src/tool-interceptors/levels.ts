import type { Class } from "../components/injection.js";
import type { AgentMeta } from "../components/meta-types.js";
import { componentOf } from "../components/metadata.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { toolInterceptorMetaOf } from "./decorator.js";

/**
 * The tool interceptors in effect per agent and tool (#384): lists add up `@Application` →
 * `@Workflow` → `@Agent` → `@Tool` / `@McpTool`, outer first, each class once (where it is first
 * listed); `excludeToolInterceptors` on an agent removes one its application or workflow lists, on a
 * tool one listed above it — by its application, its workflow or an agent that calls it. Excluding
 * one that is not inherited is `[tool-interceptor.exclude-not-inherited]`.
 */

/** The lists of one workflow: its application's, its own, its agents (with their tools). */
export interface ToolInterceptorLevels {
  readonly application: readonly Class[];
  readonly workflow: readonly Class[];
  readonly workflowName: string;
  readonly agents: readonly AgentMeta[];
}

/** A tool's own lists, by its `name`. */
interface ToolLists {
  readonly name: string;
  readonly toolInterceptors: readonly Class[];
  readonly excludeToolInterceptors: readonly Class[];
}

/** What the levels give: the classes per agent and tool name, every class listed, the rules broken. */
export interface EffectiveToolInterceptors {
  readonly byAgent: ReadonlyMap<string, ReadonlyMap<string, readonly Class[]>>;
  readonly classes: readonly Class[];
  readonly violations: readonly RuleViolation[];
}

const unique = (classes: readonly Class[]): Class[] => [...new Set(classes)];

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

const isInterceptor = (cls: Class): boolean => toolInterceptorMetaOf(cls) !== undefined;

/** A `@Tool` / `@McpTool` class's name and lists; none for a class of another kind. */
function toolListsOf(cls: Class): ToolLists | undefined {
  const component = componentOf(cls);
  if (component?.kind !== "tool" && component?.kind !== "mcp-tool") return undefined;
  const { name, toolInterceptors = [], excludeToolInterceptors = [] } = component.meta;
  return { name, toolInterceptors, excludeToolInterceptors };
}

function notInterceptors(classes: readonly Class[], where: string, list: string): RuleViolation[] {
  return classes.flatMap((cls) =>
    isInterceptor(cls)
      ? []
      : [
          violation(
            "tool-interceptor.not-an-interceptor",
            `${where}: ${nameOf(cls)} in ${list} is not a @ToolInterceptor class`,
            [nameOf(cls)],
          ),
        ],
  );
}

function notInherited(
  where: string,
  excluded: readonly Class[],
  inherited: readonly Class[],
  levels: string,
): RuleViolation[] {
  return excluded.flatMap((cls) =>
    inherited.includes(cls)
      ? []
      : [
          violation(
            "tool-interceptor.exclude-not-inherited",
            `${where}: excludeToolInterceptors lists ${nameOf(cls)}, which ${levels} does not list`,
            [where, nameOf(cls)],
          ),
        ],
  );
}

/** Inherited and own, minus the excluded, in list order. */
const kept = (all: readonly Class[], excluded: readonly Class[]): Class[] =>
  unique(all).filter((cls) => !excluded.includes(cls));

/** Each tool of the workflow's agents once, with the lists of the agents that call it. */
function toolsOf(agents: readonly AgentMeta[]): Map<string, { lists: ToolLists; above: Class[] }> {
  const tools = new Map<string, { lists: ToolLists; above: Class[] }>();
  for (const agent of agents)
    for (const cls of agent.tools ?? []) {
      const lists = toolListsOf(cls);
      if (lists === undefined) continue;
      const entry = tools.get(lists.name) ?? { lists, above: [] };
      entry.above.push(...(agent.toolInterceptors ?? []));
      tools.set(lists.name, entry);
    }
  return tools;
}

/** Each agent's and tool's interceptors and every rule the lists break, all at once. */
export function effectiveToolInterceptors(
  levels: ToolInterceptorLevels,
): EffectiveToolInterceptors {
  const inherited = unique([...levels.application, ...levels.workflow]);
  const violations = notInterceptors(inherited, levels.workflowName, "toolInterceptors");
  const tools = toolsOf(levels.agents);
  for (const { lists, above } of tools.values()) {
    violations.push(...notInterceptors(lists.toolInterceptors, lists.name, "toolInterceptors"));
    const from = unique([...inherited, ...above]);
    const where = "its application, its workflow or an agent that calls it";
    violations.push(...notInherited(lists.name, lists.excludeToolInterceptors, from, where));
  }
  const byAgent = new Map<string, ReadonlyMap<string, readonly Class[]>>();
  for (const agent of levels.agents) {
    const own = agent.toolInterceptors ?? [];
    const excluded = agent.excludeToolInterceptors ?? [];
    violations.push(...notInterceptors(own, agent.name, "toolInterceptors"));
    violations.push(
      ...notInherited(agent.name, excluded, inherited, "neither its application nor its workflow"),
    );
    const ofAgent = kept([...inherited, ...own], excluded);
    const perTool = new Map<string, readonly Class[]>();
    for (const cls of agent.tools ?? []) {
      const lists = toolListsOf(cls);
      if (lists === undefined) continue;
      const all = kept([...ofAgent, ...lists.toolInterceptors], lists.excludeToolInterceptors);
      perTool.set(lists.name, all.filter(isInterceptor));
    }
    byAgent.set(agent.name, perTool);
  }
  const listed = [
    ...inherited,
    ...levels.agents.flatMap((agent) => agent.toolInterceptors ?? []),
    ...[...tools.values()].flatMap(({ lists }) => lists.toolInterceptors),
  ];
  return { byAgent, classes: unique(listed).filter(isInterceptor), violations };
}
