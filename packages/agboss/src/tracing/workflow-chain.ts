/**
 * The workflows a run's spans are masked by (#1150): its chain — the root's name, every ancestor's
 * and its own — kept in each step's LangChain metadata as `workflowChain` (a JSON array as text,
 * so a backend keeps it as one value), which the OpenTelemetry emitter reads to mask with every one of them.
 */

/** The chain as written: a JSON array of workflow names; `undefined` for anything else. */
export function chainNamesOf(value: unknown): readonly string[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const names: unknown[] = parsed;
    return names.every((name): name is string => typeof name === "string") ? names : undefined;
  } catch {
    return undefined;
  }
}

/** The chain of a run launched from a step whose metadata is `metadata`: its own name last. */
export function workflowChainOf(
  metadata: Readonly<Record<string, unknown>> | undefined,
  workflow: string,
): string {
  const above =
    chainNamesOf(metadata?.workflowChain) ??
    (typeof metadata?.workflowName === "string" ? [metadata.workflowName] : []);
  return JSON.stringify([...above, workflow]);
}

/** The chain of a root: its own name. */
export const rootChainOf = (workflow: string): string => JSON.stringify([workflow]);

/** A parent as a queued child's run records it: its workflow, and its own parent. */
interface RecordedParent {
  readonly workflow: { readonly name: string };
  readonly parent?: RecordedParent | undefined;
}

/**
 * A queued child's own metadata (#1150): its workflow's name and version, and its chain — the
 * workflows of its parent records, the root first, then its own.
 */
export function queuedChildMetadataOf(
  workflow: { readonly name: string; readonly version: string },
  parent: RecordedParent | undefined,
): {
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly workflowChain: string;
} {
  const names: string[] = [workflow.name];
  for (let at = parent; at !== undefined; at = at.parent) names.unshift(at.workflow.name);
  return {
    workflowName: workflow.name,
    workflowVersion: workflow.version,
    workflowChain: JSON.stringify(names),
  };
}
