import type { Class } from "../components/injection.js";
import type { AgentMeta } from "../components/meta-types.js";
import { throwIfViolated, violation, type RuleViolation } from "../graph/rule-error.js";
import { toolInterceptorMetaOf, type ToolInterceptorMeta } from "./decorator.js";
import { effectiveToolInterceptors } from "./levels.js";

/**
 * A workflow's tool interceptors as assembled (#384): each listed class checked — its name ends with
 * `-tool-interceptor`, its class has `beforeToolCall`, `afterToolCall` or both
 * (`[tool-interceptor.missing-handler]`) — and each agent's chain per tool, outer first. Any rule
 * broken fails the assembly, all at once.
 */

const SUFFIX = "-tool-interceptor";

/** Which of the two methods an interceptor's class has. */
export interface ToolInterceptorHooks {
  readonly before: boolean;
  readonly after: boolean;
}

/** One tool interceptor as assembled: its class, its record, its methods. */
export interface LoadedToolInterceptor {
  readonly type: Class;
  readonly name: string;
  readonly description: string;
  readonly hooks: ToolInterceptorHooks;
}

/** A workflow's tool interceptors: each agent's chain by tool name, and every one listed. */
export interface AssembledToolInterceptors {
  readonly byAgent: ReadonlyMap<string, ReadonlyMap<string, readonly LoadedToolInterceptor[]>>;
  readonly interceptors: readonly LoadedToolInterceptor[];
}

/** What the levels above the agents are: the application's list, the workflow's and its name. */
export interface ToolInterceptorOwners {
  readonly application: readonly Class[];
  readonly workflow: readonly Class[];
  readonly workflowName: string;
}

const hasMethod = (cls: Class, method: string): boolean =>
  typeof Reflect.get(cls.prototype as object, method) === "function";

/** The methods of an interceptor's class. */
export const hooksOf = (cls: Class): ToolInterceptorHooks => ({
  before: hasMethod(cls, "beforeToolCall"),
  after: hasMethod(cls, "afterToolCall"),
});

/** Every rule one interceptor class breaks: its name's suffix, its methods. */
export function toolInterceptorViolations(cls: Class, meta: ToolInterceptorMeta): RuleViolation[] {
  const found: RuleViolation[] = [];
  if (!meta.name.endsWith(SUFFIX))
    found.push(
      violation("name.kind-suffix", `${meta.name}: a tool interceptor's name ends with ${SUFFIX}`, [
        cls.name,
      ]),
    );
  const hooks = hooksOf(cls);
  if (!hooks.before && !hooks.after)
    found.push(
      violation(
        "tool-interceptor.missing-handler",
        `${meta.name}: ${cls.name} has neither beforeToolCall(call) nor afterToolCall(call) — implements BeforeToolCall, AfterToolCall or both`,
        [cls.name],
      ),
    );
  return found;
}

/** An interceptor class as assembled; none for a class that is not one. */
export function loadedToolInterceptorOf(cls: Class): LoadedToolInterceptor | undefined {
  const meta = toolInterceptorMetaOf(cls);
  if (meta === undefined) return undefined;
  return { type: cls, name: meta.name, description: meta.description, hooks: hooksOf(cls) };
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
  return { byAgent, interceptors };
}
