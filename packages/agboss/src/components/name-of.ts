import { applicationDeclarationOf } from "../application/application.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { NameOf } from "../flow/generated-types.js";
import type { Class } from "./injection.js";
import { ComponentError, componentOf } from "./metadata.js";

/**
 * `nameOf(ComponentClass)` (#261): the `name` of any AGBoss-decorated class — a workflow, a start, a
 * finish, an agent, a router, an action, a tool, a budget, an application, … — the stable key
 * serialized data are compared by: `event.workflow.name === nameOf(SupportWorkflow)`,
 * `event.step.component.name === nameOf(CriticAgent)`. Its type is the name's literal where the
 * generated `.agboss/types.d.ts` brands the class, else `string`; a class no AGBoss decorator
 * describes throws `ComponentError`.
 */
export type ComponentName<TComponent extends Class> = [NameOf<InstanceType<TComponent>>] extends [
  never,
]
  ? string
  : NameOf<InstanceType<TComponent>>;

/** The `name` a decorator recorded on the class, if any. */
function recordedName(component: Class): string | undefined {
  const declared: unknown = declarationOf(component)?.options;
  if (typeof declared === "object" && declared !== null && "name" in declared) {
    return String(declared.name);
  }
  const meta: unknown = componentOf(component)?.meta;
  if (typeof meta === "object" && meta !== null && "name" in meta) return String(meta.name);
  return applicationDeclarationOf(component)?.options.name;
}

export function nameOf<TComponent extends Class>(component: TComponent): ComponentName<TComponent> {
  const name = recordedName(component);
  if (name === undefined) {
    throw new ComponentError(
      `nameOf(${component.name || "(anonymous class)"}): no AGBoss decorator describes this class`,
    );
  }
  // the decorator recorded this name; the generated brand types it as the same literal (or string)
  return name;
}
