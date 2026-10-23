import type { ApplicationOptions } from "../../application/application.js";
import type { ComponentName } from "../registry.js";
import type { ImportTable } from "./imports.js";
import type { TypeTable } from "./tables.js";

/**
 * The context types of `.agboss/types.d.ts` (#261): each start's entry names the context
 * subclasses its application declares (`tenant`, `execution`), so `app.execute(Start, input, {
 * tenant, execution })` is typed by them; and a declared `ExecutionContext` subclass gets its
 * application's tenant class as the type of `tenant` (`this.executionContext.tenant.plan`).
 */

/** The starts of one workflow and the application that lists it (when exactly one does). */
export interface StartsOfApplication {
  readonly starts: readonly ComponentName[];
  readonly application: ApplicationOptions | undefined;
}

/** What the contexts add to the generated file. */
export interface ContextTypes {
  /** `WorkflowStarts` with `tenant` / `execution` on the starts of applications that declare them. */
  readonly workflowStarts: TypeTable;
  /** `declare module` blocks: each declared execution subclass's `tenant`. */
  readonly augmentations: readonly string[];
}

/** `; tenant: X; execution: Y` for an application that declares its own classes. */
function contextMembers(application: ApplicationOptions, names: ImportTable): string {
  const { tenantContext, executionContext } = application;
  return [
    ...(tenantContext === undefined ? [] : [`tenant: ${names.refPlain(tenantContext)}`]),
    ...(executionContext === undefined ? [] : [`execution: ${names.refPlain(executionContext)}`]),
  ]
    .map((member) => `; ${member}`)
    .join("");
}

/** The start entry `{ input: …; output: … }` with the context members before its closing brace. */
const withMembers = (entry: string, members: string): string =>
  members === "" || !entry.endsWith(" }") ? entry : `${entry.slice(0, -2)}${members} }`;

/** The `declare module` block that types a declared execution subclass's `tenant`. */
function tenantAugmentation(application: ApplicationOptions, names: ImportTable): string[] {
  const { tenantContext, executionContext } = application;
  if (tenantContext === undefined || executionContext === undefined) return [];
  const tenant = names.refPlain(tenantContext);
  names.refPlain(executionContext);
  const imported = names.classes.find((found) => found.component === executionContext);
  if (imported === undefined) return [];
  return [
    "",
    `declare module "${names.specifier(imported.file)}" {`,
    `  interface ${imported.component.name} {`,
    `    readonly tenant: ${tenant};`,
    "  }",
    "}",
  ];
}

export function contextTypesOf(
  workflowStarts: TypeTable,
  workflows: readonly StartsOfApplication[],
  names: ImportTable,
): ContextTypes {
  const starts = new Map(workflowStarts);
  const augmented = new Set<ApplicationOptions>();
  // one block per declared execution class, sorted: the file is the same whatever the order of the
  // workflows and modules it is generated from (two applications with their own contexts, #396)
  const blocks = new Set<string>();
  for (const { starts: startNames, application } of workflows) {
    if (application === undefined) continue;
    const members = contextMembers(application, names);
    for (const start of startNames) {
      const entry = starts.get(start);
      if (entry !== undefined) starts.set(start, withMembers(entry, members));
    }
    if (augmented.has(application)) continue;
    augmented.add(application);
    const block = tenantAugmentation(application, names);
    if (block.length > 0) blocks.add(block.join("\n"));
  }
  const augmentations = [...blocks].sort().flatMap((block) => block.split("\n"));
  return { workflowStarts: starts, augmentations };
}
