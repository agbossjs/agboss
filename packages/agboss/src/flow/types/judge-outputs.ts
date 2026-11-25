import type { Class } from "../../components/injection.js";
import type { JudgeOutputShape } from "../../components/judge-decorators.js";
import { componentOf } from "../../components/metadata.js";
import type { ImportTable } from "./imports.js";
import { valueText } from "./shapes.js";
import type { TypeTable } from "./tables.js";

/**
 * The `JudgeOutputs` table (#1290): per `@Judge`, the value its `judge(input)` reads as `output` — so
 * `JudgeInput<Self>` is typed without the class repeating its output. Each judge class is branded with
 * its name (`readonly [agbossComponent]?: { readonly name: "decisions-judge" }`), what `JudgeInput<T>`
 * looks the entry up by.
 */

/** The name a `@Judge` class is known by; `undefined` for any other class. */
export function judgeComponentNameOf(cls: Class): string | undefined {
  const component = componentOf(cls);
  return component?.kind === "judge" ? component.meta.name : undefined;
}

/** The value a judge reads of an output shape: the shape's value (a polymorphic list's items are the instances). */
const judgedValueText = (output: JudgeOutputShape, names: ImportTable): string =>
  valueText(output, names);

/** Whether every class the judge's entry names is exported (tried on a table of its own). */
function isTypable(judge: Class, output: JudgeOutputShape, names: ImportTable): boolean {
  const probe = names.fork();
  probe.ref(judge);
  judgedValueText(output, probe);
  return probe.unexported.length === 0;
}

/**
 * The entries of the decorated `components` that are `@Judge` classes, each recorded for its brand. A
 * judge whose output needs a class no module exports is left out, not a failure: nothing reads it yet.
 */
export function judgeOutputsTableOf(components: readonly Class[], names: ImportTable): TypeTable {
  const table = new Map<string, string>();
  for (const cls of components) {
    const found = componentOf(cls);
    if (found?.kind !== "judge" || table.has(found.meta.name)) continue;
    if (!isTypable(cls, found.meta.output, names)) continue;
    names.ref(cls);
    table.set(found.meta.name, judgedValueText(found.meta.output, names));
  }
  return table;
}
