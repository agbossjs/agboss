import type { Class } from "../components/injection.js";
import type { AgentMeta } from "../components/meta-types.js";
import { componentOf } from "../components/metadata.js";
import { kebabNameProblem } from "../flow/names.js";
import { throwIfViolated, violation, type RuleViolation } from "../graph/rule-error.js";
import { toolInterceptorMetaOf, type ToolInterceptorMeta } from "./decorator.js";
import { toolHooksOf, ToolHookPhase } from "./hooks.js";
import { effectiveToolInterceptors } from "./levels.js";

/**
 * A workflow's tool interceptors as assembled (#384): each listed class checked — its name is
 * kebab-case, its class has a `@BeforeTool` / `@AfterTool` method, `beforeAnyTool` or
 * `afterAnyTool` (`[tool-interceptor.missing-handler]`), every target is a tool, no tool has two
 * methods in one phase, no method is a misspelt hook — and each agent's chain per tool, outer
 * first. Any rule broken fails the assembly, all at once.
 */

/** What an interceptor's class hooks: the names of the tools of its target methods, the catch-alls. */
export interface ToolInterceptorHooks {
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly beforeAny: boolean;
  readonly afterAny: boolean;
}

/** The method each target tool's calls go to, by phase. */
export interface ToolInterceptorMethods {
  readonly before: ReadonlyMap<Class, string>;
  readonly after: ReadonlyMap<Class, string>;
}

/** One tool interceptor as assembled: its class, its record, its methods. */
export interface LoadedToolInterceptor {
  readonly type: Class;
  readonly name: string;
  readonly description?: string;
  readonly hooks: ToolInterceptorHooks;
  readonly methods: ToolInterceptorMethods;
}

/** A workflow's tool interceptors: each agent's chain by tool name, and every one listed. */
export interface AssembledToolInterceptors {
  readonly byAgent: ReadonlyMap<string, ReadonlyMap<string, readonly LoadedToolInterceptor[]>>;
  readonly interceptors: readonly LoadedToolInterceptor[];
  /** The `@Tool` / `@McpTool` class of each tool name the agents call. */
  readonly toolTypes: ReadonlyMap<string, Class>;
}

/** What the levels above the agents are: the application's list, the workflow's and its name. */
export interface ToolInterceptorOwners {
  readonly application: readonly Class[];
  readonly workflow: readonly Class[];
  readonly workflowExcludes?: readonly Class[];
  readonly workflowName: string;
}

const hasMethod = (cls: Class, method: string): boolean =>
  typeof Reflect.get(cls.prototype as object, method) === "function";

const toolNameOf = (tool: Class): string | undefined => {
  const component = componentOf(tool);
  return component?.kind === "tool" || component?.kind === "mcp-tool"
    ? component.meta.name
    : undefined;
};

/** The target-bound methods of a class by phase and tool class; the first of a tool's wins. */
export const methodsOf = (cls: Class): ToolInterceptorMethods => {
  const by = (phase: ToolHookPhase): Map<Class, string> => {
    const map = new Map<Class, string>();
    for (const hook of toolHooksOf(cls))
      if (hook.phase === phase)
        for (const tool of hook.tools) if (!map.has(tool)) map.set(tool, hook.method);
    return map;
  };
  return { before: by(ToolHookPhase.Before), after: by(ToolHookPhase.After) };
};

/** The hooks of an interceptor's class. */
export const hooksOf = (cls: Class): ToolInterceptorHooks => {
  const methods = methodsOf(cls);
  const names = (map: ReadonlyMap<Class, string>): string[] =>
    [...map.keys()].flatMap((tool) => toolNameOf(tool) ?? []);
  return {
    before: names(methods.before),
    after: names(methods.after),
    beforeAny: hasMethod(cls, "beforeAnyTool"),
    afterAny: hasMethod(cls, "afterAnyTool"),
  };
};

const ANY_HOOKS = new Set(["beforeAnyTool", "afterAnyTool"]);
const HOOK_LIKE = /^(before|after)\w*Tool\w*$/u;

/** The rules of the target-bound methods: tools only, one method per tool and phase. */
function targetViolations(cls: Class, meta: ToolInterceptorMeta): RuleViolation[] {
  const found: RuleViolation[] = [];
  const seen = new Set<string>();
  for (const hook of toolHooksOf(cls))
    for (const tool of hook.tools) {
      const name = toolNameOf(tool);
      const key = `${hook.phase}:${name ?? ""}`;
      const decorator = hook.phase === ToolHookPhase.Before ? "BeforeTool" : "AfterTool";
      if (name === undefined)
        found.push(
          violation(
            "tool-interceptor.target-not-a-tool",
            `${meta.name}: ${cls.name}.${hook.method} names ${tool.name || "(anonymous class)"}, which is not a @Tool / @McpTool class`,
            [cls.name],
          ),
        );
      else if (seen.has(key))
        found.push(
          violation(
            "tool-interceptor.duplicate-hook",
            `${meta.name}: ${cls.name} has two @${decorator} methods for ${name} — one method per tool; share a rule through a private method`,
            [cls.name],
          ),
        );
      seen.add(key);
    }
  return found;
}

/** A method named like a hook that is none: a typo, or the 0.1.0 `beforeToolCall`. */
function unknownHookViolations(cls: Class, meta: ToolInterceptorMeta): RuleViolation[] {
  const decorated = new Set(toolHooksOf(cls).map((hook) => hook.method));
  const names = new Set<string>();
  for (
    let proto: object | null = cls.prototype as object;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  )
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
  return [...names]
    .filter((method) => HOOK_LIKE.test(method) && !ANY_HOOKS.has(method) && !decorated.has(method))
    .map((method) =>
      violation(
        "tool-interceptor.unknown-hook",
        `${meta.name}: ${cls.name}.${method} is no hook of a tool interceptor — decorate it with @BeforeTool(Tool) / @AfterTool(Tool), or name it beforeAnyTool / afterAnyTool`,
        [cls.name],
      ),
    );
}

/** Every rule one interceptor class breaks: its name, its methods. */
export function toolInterceptorViolations(cls: Class, meta: ToolInterceptorMeta): RuleViolation[] {
  const found: RuleViolation[] = [];
  const problem = kebabNameProblem(meta.name, "a tool interceptor");
  if (problem !== undefined) found.push(violation(problem.code, problem.message, [cls.name]));
  const hooks = toolHooksOf(cls);
  if (hooks.length === 0 && !hasMethod(cls, "beforeAnyTool") && !hasMethod(cls, "afterAnyTool"))
    found.push(
      violation(
        "tool-interceptor.missing-handler",
        `${meta.name}: ${cls.name} has no @BeforeTool(Tool), @AfterTool(Tool), beforeAnyTool(call) or afterAnyTool(call) method`,
        [cls.name],
      ),
    );
  return [...found, ...targetViolations(cls, meta), ...unknownHookViolations(cls, meta)];
}

/** An interceptor class as assembled; none for a class that is not one. */
export function loadedToolInterceptorOf(cls: Class): LoadedToolInterceptor | undefined {
  const meta = toolInterceptorMetaOf(cls);
  if (meta === undefined) return undefined;
  return {
    type: cls,
    name: meta.name,
    ...(meta.description === undefined ? {} : { description: meta.description }),
    hooks: hooksOf(cls),
    methods: methodsOf(cls),
  };
}

/** The workflow's tool interceptors over its application's; a broken rule fails the assembly. */
export function toolInterceptorPartsOf(
  owners: ToolInterceptorOwners,
  agents: readonly AgentMeta[],
): AssembledToolInterceptors {
  const effective = effectiveToolInterceptors({ ...owners, agents });
  const interceptors = effective.classes.flatMap((cls) => loadedToolInterceptorOf(cls) ?? []);
  throwIfViolated([
    ...effective.violations,
    ...interceptors.flatMap((loaded) => {
      const meta = toolInterceptorMetaOf(loaded.type);
      return meta === undefined ? [] : toolInterceptorViolations(loaded.type, meta);
    }),
  ]);
  const of = (classes: readonly Class[]): LoadedToolInterceptor[] =>
    classes.flatMap((cls) => interceptors.find((loaded) => loaded.type === cls) ?? []);
  const byAgent = new Map(
    [...effective.byAgent].map(([agent, tools]) => [
      agent,
      new Map([...tools].map(([tool, classes]) => [tool, of(classes)] as const)),
    ]),
  );
  const toolTypes = new Map<string, Class>();
  for (const agent of agents)
    for (const tool of agent.tools ?? []) {
      const name = toolNameOf(tool);
      if (name !== undefined) toolTypes.set(name, tool);
    }
  return { byAgent, interceptors, toolTypes };
}
