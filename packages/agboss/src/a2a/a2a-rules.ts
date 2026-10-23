import type { ApplicationOptions } from "../application/application.js";
import type { Class, Provider } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { moduleOf } from "../components/module.js";
import { flowClassesOf, withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { kindSuffixProblem, NameKind } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";

/**
 * The declared contracts of an application at assembly (#398 PR 3). Its `exposes` are `@A2AExpose`
 * or `@McpExpose` classes (`[application.not-an-expose]`), each name once
 * (`[application.duplicate-expose]`); an `@A2AExpose` exports `@WorkflowStart`s of the application's
 * workflows (`[application.expose-unknown-start]`). Every `@A2AAgent` it lists names its `target`
 * (`[a2a.target-required]`). Names: `-a2a-agent` on a `…A2AAgent` class, `-a2a-expose` on a
 * `…A2AExpose` class (`[name.kind-suffix]`).
 */

const isClass = (provider: Provider): provider is Class => !("provide" in provider);

/** `[name.kind-suffix]` for a contract's `name` and its class name. */
function contractNameViolations(
  name: string,
  cls: Class,
  kind: NameKind,
  classSuffix: string,
  where: string,
): RuleViolation[] {
  const found: RuleViolation[] = [];
  const problem = kindSuffixProblem(name, kind);
  if (problem !== undefined) found.push(violation(problem.code, problem.message, [where]));
  const className = cls.name;
  if (className.length <= classSuffix.length || !className.endsWith(classSuffix)) {
    const message = `class ${className} — name it ${className}${classSuffix}`;
    found.push(violation("name.kind-suffix", message, [where]));
  }
  return found;
}

/** The starts of the application's workflows and their children, by class. */
function startsOf(workflows: readonly Class[]): ReadonlySet<Class> {
  const starts = withChildWorkflows(workflows).flatMap((workflow) => {
    const declaration = declarationOf(workflow);
    if (declaration?.kind !== NodeKind.Workflow) return [];
    return flowClassesOf(declaration.options.flow).filter(
      (node) => declarationOf(node)?.kind === NodeKind.Start,
    );
  });
  return new Set(starts);
}

function exposeViolations(options: ApplicationOptions): RuleViolation[] {
  const where = options.name;
  const starts = startsOf(options.workflows);
  const seen = new Set<string>();
  return (options.exposes ?? []).flatMap((expose): RuleViolation[] => {
    const meta = componentOf(expose);
    if (meta?.kind !== "a2a-expose" && meta?.kind !== "mcp-expose") {
      const message = `${expose.name} in ${where}'s exposes is neither an @A2AExpose nor an @McpExpose`;
      return [violation("application.not-an-expose", message, [where])];
    }
    const found: RuleViolation[] = [];
    if (seen.has(meta.meta.name)) {
      const message = `${where} exposes two contracts named ${meta.meta.name} — one name per contract`;
      found.push(violation("application.duplicate-expose", message, [where]));
    }
    seen.add(meta.meta.name);
    if (meta.kind === "mcp-expose") return found;
    found.push(
      ...contractNameViolations(meta.meta.name, expose, NameKind.A2AExpose, "A2AExpose", where),
    );
    for (const exported of meta.meta.exports) {
      if (starts.has(exported)) continue;
      const message = `${meta.meta.name} exports ${exported.name}, which is no @WorkflowStart of ${where}'s workflows — export a start of a listed workflow`;
      found.push(violation("application.expose-unknown-start", message, [where]));
    }
    return found;
  });
}

/** Every provider of the application and its workflows. */
function providersOf(options: ApplicationOptions): readonly Class[] {
  const ofWorkflows = withChildWorkflows(options.workflows).flatMap((workflow) =>
    declarationOf(workflow)?.kind === NodeKind.Workflow ? (moduleOf(workflow).providers ?? []) : [],
  );
  return [...new Set([...(options.providers ?? []), ...ofWorkflows].filter(isClass))];
}

function a2aAgentViolations(options: ApplicationOptions): RuleViolation[] {
  const where = options.name;
  return providersOf(options).flatMap((cls): RuleViolation[] => {
    const meta = componentOf(cls);
    if (meta?.kind !== "a2a-agent") return [];
    const { name, target } = meta.meta;
    const found = contractNameViolations(name, cls, NameKind.A2AAgent, "A2AAgent", where);
    // untyped (JS) code may leave the contract out (the decorator's type requires it), or empty
    const declared = target as Partial<typeof target> | undefined;
    if (!declared?.application || !declared.start) {
      const message = `${name} names no target — @A2AAgent({ target: { application, start }, input, output }): the receiving application and its exported start`;
      found.push(violation("a2a.target-required", message, [where]));
    }
    return found;
  });
}

/** The declared contracts' violations of an application. */
export const contractRuleViolations = (options: ApplicationOptions): RuleViolation[] => [
  ...exposeViolations(options),
  ...a2aAgentViolations(options),
];
