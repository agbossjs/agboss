import type { WorkflowDefaults } from "../flow/decorators/workflow.js";
import { withoutUndefined } from "../types/defined.js";

/**
 * The `defaults` cascade (#261): application → workflow → component. `@Application({ defaults })`
 * and `@Workflow({ defaults })` are merged field by field — a workflow that sets only
 * `history.limit` takes the rest from the application; the component's own field wins over both
 * (applied where each setting is resolved); nothing set → the framework's built-in.
 */

/** Which level set a default. */
export enum DefaultsLevel {
  Application = "application",
  Workflow = "workflow",
}

/** The levels a workflow's defaults are merged from, each with its `defaults` and its `name`. */
export interface DefaultsLevels {
  readonly application?: { readonly name: string; readonly defaults?: WorkflowDefaults };
  readonly workflow: { readonly name: string; readonly defaults?: WorkflowDefaults };
}

/** Where a default came from: the level and the name of its application or workflow. */
export interface DefaultSource {
  readonly level: DefaultsLevel;
  readonly name: string;
}

type Section = keyof WorkflowDefaults;

/** Two sections merged field by field, the workflow's fields over the application's. */
function merged<TSection extends object>(
  application: TSection | undefined,
  workflow: TSection | undefined,
): TSection | undefined {
  if (application === undefined) return workflow;
  if (workflow === undefined) return application;
  return { ...application, ...workflow };
}

/** The defaults of one workflow: its own over its application's, field by field. */
export function cascadeDefaults(
  application: WorkflowDefaults | undefined,
  workflow: WorkflowDefaults | undefined,
): WorkflowDefaults | undefined {
  if (application === undefined) return workflow;
  if (workflow === undefined) return application;
  return withoutUndefined({
    models: merged(application.models, workflow.models),
    router: merged(application.router, workflow.router),
    guardrail: merged(application.guardrail, workflow.guardrail),
    tools: merged(application.tools, workflow.tools),
    history: merged(application.history, workflow.history),
    flow: merged(application.flow, workflow.flow),
  });
}

/** Where `defaults.<section>.<field>` came from; undefined when no level sets it (the built-in). */
export function defaultSourceOf(
  levels: DefaultsLevels,
  section: Section,
  field: string,
): DefaultSource | undefined {
  const sets = (defaults: WorkflowDefaults | undefined): boolean => {
    const value: unknown = defaults?.[section];
    return typeof value === "object" && value !== null && field in value;
  };
  if (sets(levels.workflow.defaults))
    return { level: DefaultsLevel.Workflow, name: levels.workflow.name };
  if (levels.application !== undefined && sets(levels.application.defaults))
    return { level: DefaultsLevel.Application, name: levels.application.name };
  return undefined;
}
