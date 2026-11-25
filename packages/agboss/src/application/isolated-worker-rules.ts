import { NodeKind } from "../flow/ast.js";
import type { Class } from "../components/injection.js";
import { ChildPlacement } from "../flow/child-placement.js";
import {
  childWorkflowsOf,
  placementOfWorkflow,
  type Placements,
} from "../flow/analyse/child-placements.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { ChildExecutionQueueRepository } from "../infrastructure/child-execution-queue.repository.js";
import type { ApplicationOptions } from "./application.js";
import { implementationsOf, isInMemory } from "./implementations.js";
import { providersOf } from "./listed-providers.js";

/**
 * `@Application({ isolatedWorker: { entry } })` (#1286b, D9): required once a child workflow of
 * the application resolves to `ChildPlacement.IsolatedWorker`, a non-empty file URL or absolute path
 * when given — what a forked process loads to build the application.
 */

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** The child workflows of the application that run with `IsolatedWorker`. */
export function isolatedChildrenOf(
  options: ApplicationOptions,
  placements: Placements | undefined,
): readonly Class[] {
  const applicationDefault = options.defaults?.workflows?.placement;
  const children = new Set<Class>();
  for (const workflow of withChildWorkflows(options.workflows)) {
    const declaration = declarationOf(workflow);
    if (declaration?.kind !== NodeKind.Workflow) continue;
    for (const child of childWorkflowsOf(declaration.options.flow))
      if (
        placementOfWorkflow(child, applicationDefault, placements) === ChildPlacement.IsolatedWorker
      )
        children.add(child);
  }
  return [...children];
}

const isFileUrlOrAbsolutePath = (entry: string): boolean =>
  entry.startsWith("file://") || entry.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entry);

/** A fork shares the stores through the child queue: the built-in in-memory one is in no other process. */
function queueViolations(options: ApplicationOptions): RuleViolation[] {
  if (!isInMemory(implementationsOf(providersOf(options)), ChildExecutionQueueRepository))
    return [];
  return [
    violation(
      "application.isolated-worker-invalid",
      "an IsolatedWorker child runs in a process of its own, which reaches the child queue only through a store the processes share — use @Application({ storage }) with a database the processes share (SqliteDriver, PostgresDriver, …), or list SqliteChildExecutionQueueRepository (or your own ChildExecutionQueueRepository) in @Application({ providers })",
      [options.name],
    ),
  ];
}

export function isolatedWorkerViolations(
  options: ApplicationOptions,
  placements: Placements | undefined,
): RuleViolation[] {
  const entry = options.isolatedWorker?.entry;
  if (entry !== undefined) {
    if (typeof entry === "string" && isFileUrlOrAbsolutePath(entry))
      return queueViolations(options);
    return [
      violation(
        "application.isolated-worker-invalid",
        "its isolatedWorker.entry is not a file URL or an absolute path — @Application({ isolatedWorker: { entry: import.meta.url } })",
        [options.name],
      ),
    ];
  }
  const children = isolatedChildrenOf(options, placements);
  if (children.length === 0) return [];
  const names = children.map(nameOf).join(", ");
  return [
    violation(
      "application.isolated-worker-invalid",
      `${names} run with ChildPlacement.IsolatedWorker, and the application sets no isolatedWorker — @Application({ isolatedWorker: { entry: import.meta.url } }) names the module a forked process loads`,
      [options.name],
    ),
  ];
}
