import type { Class } from "../components/injection.js";
import { NodeKind } from "../flow/ast.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { AssembledWorkflow } from "../workflow.js";

/**
 * The rules across the workflows of one application (#261): workflow names are unique, a start is
 * the door of one workflow (`[application.ambiguous-start]`), and a component name means one class
 * in the whole application (`[graph.duplicate-node-name]`) — names key records and traces.
 */

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

function duplicateWorkflows(workflows: readonly AssembledWorkflow[]): RuleViolation[] {
  const seen = new Map<string, Class>();
  return workflows.flatMap((workflow) => {
    const { name } = workflow.config;
    const first = seen.get(name);
    seen.set(name, first ?? workflow.graph.type);
    if (first === undefined) return [];
    const what =
      first === workflow.graph.type
        ? `${nameOf(first)} is listed twice`
        : `${nameOf(first)} and ${nameOf(workflow.graph.type)} are both named "${name}"`;
    return [
      violation(
        "application.duplicate-workflow",
        `${what} — a workflow name is unique in the application`,
        [name],
      ),
    ];
  });
}

/** Every node class of every workflow by its name, with the workflows it is in. */
function nodesByName(
  workflows: readonly AssembledWorkflow[],
): Map<string, { readonly kind: NodeKind; readonly classes: Map<Class, string[]> }> {
  const byName = new Map<string, { kind: NodeKind; classes: Map<Class, string[]> }>();
  for (const workflow of workflows) {
    for (const node of workflow.graph.nodes.values()) {
      const entry = byName.get(node.id) ?? { kind: node.kind, classes: new Map<Class, string[]>() };
      const owners = entry.classes.get(node.component) ?? [];
      entry.classes.set(node.component, [...owners, workflow.config.name]);
      byName.set(node.id, entry);
    }
  }
  return byName;
}

export function crossWorkflowViolations(workflows: readonly AssembledWorkflow[]): RuleViolation[] {
  const found = duplicateWorkflows(workflows);
  for (const [name, { kind, classes }] of nodesByName(workflows)) {
    if (classes.size > 1) {
      const names = [...classes.keys()].map(nameOf).join(" and ");
      found.push(
        violation(
          "graph.duplicate-node-name",
          `${names} are both named "${name}" — a name is unique in the application; rename one`,
          [name],
        ),
      );
      continue;
    }
    const [owners = []] = classes.values();
    if (kind === NodeKind.Start && new Set(owners).size > 1) {
      found.push(
        violation(
          "application.ambiguous-start",
          `${name} is a start of ${[...new Set(owners)].join(" and ")} — a start is the door of one workflow; give each workflow its own`,
          [name],
        ),
      );
    }
  }
  return found;
}
