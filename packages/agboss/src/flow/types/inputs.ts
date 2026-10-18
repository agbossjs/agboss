import type { Class } from "../../components/injection.js";
import type { RuleViolation } from "../../graph/rule-error.js";
import type { ResolvedField } from "../analyse/fields.js";
import type { InputShape, ProjectedField } from "../analyse/projection.js";
import type { ComponentName } from "../registry.js";
import { TablesImport, type ImportTable } from "./imports.js";
import { producedText, propertyName } from "./shapes.js";

/**
 * A node's `InputOf<X>` (#272 S4, #270): one member per input shape — every reachable abstract scope
 * projected onto the node's `input`, duplicates removed, one member per combination of present
 * values — up to `MAX_EXACT_INPUT_SHAPES`; above it
 * one flat object, where a field missing in some shape is `?:` and its producers are the union, plus
 * a note for `agboss check`. A node whose input breaks a data rule gets the rule's message instead.
 */

/** Exact unions up to this many input shapes; one flat type above (a framework constant, S4). */
export const MAX_EXACT_INPUT_SHAPES = 32;

/** What the generator knows of one node's input, over every workflow the node is in. */
export interface NodeInput {
  readonly name: ComponentName;
  readonly fields: readonly ResolvedField[];
  readonly shapes: readonly InputShape[];
  /** Who can have written any version a `historyOf` field reads, by field name (#299 S56). */
  readonly versionProducers: ReadonlyMap<string, readonly ComponentName[]>;
  /** The data rules the input breaks, as `[code] message`. */
  readonly problems: readonly string[];
}

/** A generated `Inputs` entry and, for a flat one, the line `agboss check` prints. */
export interface InputEntry {
  readonly type: string;
  readonly note?: string;
}

/** Writes a component's class by its name (the producers of `Produced<T, P>`). */
export type ComponentOf = (name: ComponentName) => Class;

/** Rules an input's type reports besides `input.*`: an unread item, a child's start (#263). */
const INPUT_RULES: ReadonlySet<string> = new Set([
  "launch.item-not-read",
  "graph.no-matching-start",
  "graph.ambiguous-start",
]);

/** Whether a rule's problem is one an input's type reports. */
export const isInputProblem = (found: RuleViolation): boolean =>
  found.code.startsWith("input.") || INPUT_RULES.has(found.code);

const errorType = (message: string): string => `{ readonly __error: ${JSON.stringify(message)} }`;

function producersText(
  producers: readonly ComponentName[],
  names: ImportTable,
  componentOf: ComponentOf,
): string {
  return [...new Set(producers)]
    .sort()
    .map((producer) => `typeof ${names.ref(componentOf(producer))}`)
    .join(" | ");
}

interface ShapeWriter {
  readonly fields: readonly ResolvedField[];
  readonly versionProducers: NodeInput["versionProducers"];
  readonly names: ImportTable;
  readonly componentOf: ComponentOf;
}

/** One field of a shape: present with its producers, or absent (`?: undefined`). */
function fieldText(
  writer: ShapeWriter,
  field: ResolvedField,
  projected: readonly ProjectedField[],
): string {
  const key = propertyName(field.name);
  const present = projected.filter((candidate) => candidate.isPresent);
  if (present.length === 0) return `${key}?: undefined`;
  // a history's earlier versions may come from any producer of its class
  const versions = writer.versionProducers.get(field.name) ?? [];
  const producers = producersText(
    [...present.flatMap((candidate) => candidate.producers), ...versions],
    writer.names,
    writer.componentOf,
  );
  const optional = present.length === projected.length ? "" : "?";
  return `${key}${optional}: ${producedText(field.shape, producers, writer.names)}`;
}

/** An object over shapes: one shape gives an exact member, all of them the flat type. */
function objectText(writer: ShapeWriter, shapes: readonly InputShape[]): string {
  const fields = writer.fields.map((field, index) =>
    fieldText(
      writer,
      field,
      shapes.flatMap((shape) => shape[index] ?? []),
    ),
  );
  return `{ ${fields.join("; ")} }`;
}

/**
 * The shapes grouped by which fields are present: one member of `InputOf` per combination of
 * values; within it a field's producers are the union over its scopes (`Produced<T, A | B>`).
 */
function byPresence(shapes: readonly InputShape[]): readonly (readonly InputShape[])[] {
  const groups = new Map<string, InputShape[]>();
  for (const shape of shapes) {
    const key = shape.map((field) => (field.isPresent ? "1" : "0")).join("");
    groups.set(key, [...(groups.get(key) ?? []), shape]);
  }
  return [...groups.values()];
}

export function inputEntry(
  input: NodeInput,
  names: ImportTable,
  componentOf: ComponentOf,
): InputEntry {
  if (input.problems.length > 0) return { type: errorType(input.problems.join("; ")) };
  if (input.fields.length === 0) return { type: names.use(TablesImport.NoInput) };
  if (input.shapes.length === 0)
    return { type: errorType(`${input.name} is reached by no path from a workflow start`) };
  const writer: ShapeWriter = {
    fields: input.fields,
    versionProducers: input.versionProducers,
    names,
    componentOf,
  };
  const groups = byPresence(input.shapes);
  if (groups.length > MAX_EXACT_INPUT_SHAPES) {
    const note = `${input.name}: ${String(groups.length)} input shapes — InputOf is flat (no narrowing between fields)`;
    return { type: objectText(writer, input.shapes), note };
  }
  const members = groups.map((group) => objectText(writer, group)).sort();
  return {
    type: members.length === 1 ? members.join("") : members.map((m) => `| ${m}`).join("\n"),
  };
}

/**
 * A child workflow's `Inputs` entry (#263): its start is chosen per edge, so the entry only carries
 * the problems of that choice (`[graph.no-matching-start]`, `[input.missing-on-path]`, …) — which
 * make `.toWorkflow(W)` a compile error — and `NoInput` otherwise.
 */
export const childInputEntry = (input: NodeInput, names: ImportTable): InputEntry =>
  input.problems.length > 0
    ? { type: errorType(input.problems.join("; ")) }
    : { type: names.use(TablesImport.NoInput) };
