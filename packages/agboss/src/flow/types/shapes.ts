import type { WorkflowStartInput } from "../decorators/workflow-start.js";
import type { InputFieldShape } from "../decorators/declaration.js";
import {
  isValueShape,
  Wrapper,
  type ListElementShape,
  type OutputShape,
  type ValueShape,
} from "../dto-wrappers.js";
import { sortedVariants } from "../analyse/labels.js";
import { TablesImport, type ImportTable } from "./imports.js";

/**
 * How shapes are written as types in the generated file (#270): `XDto`, `listOf(XDto)` →
 * `readonly XDto[]`, `oneOf(A, B)` → `A | B`, `optional(X)` → `X | undefined`; a value read from
 * the path scope is `Produced<T, P>`, a list field an array of `Produced` elements.
 */

/** A property name as TypeScript accepts it. */
export const propertyName = (name: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);

function elementText(element: ListElementShape, names: ImportTable): string {
  if (typeof element === "function") return names.dto(element);
  return sortedVariants(element)
    .map((dto) => names.dto(dto))
    .join(" | ");
}

/** The plain value a shape stands for. */
export function valueText(shape: ValueShape | OutputShape, names: ImportTable): string {
  if (typeof shape === "function") return names.dto(shape);
  switch (shape.kind) {
    case Wrapper.List: {
      const element = elementText(shape.element, names);
      return typeof shape.element === "function"
        ? `readonly ${element}[]`
        : `readonly (${element})[]`;
    }
    case Wrapper.OneOf:
      return elementText(shape, names);
    case Wrapper.Optional:
      return `${valueText(shape.inner, names)} | undefined`;
  }
}

/** What a producer gives: its output's shape, `NoOutput` without one. */
export function outputText(output: OutputShape | undefined, names: ImportTable): string {
  return output === undefined ? names.use(TablesImport.NoOutput) : valueText(output, names);
}

/** What `app.execute(Start, input)` takes: the DTO, its list, or the map of fields. */
export function startInputText(input: WorkflowStartInput, names: ImportTable): string {
  if (isValueShape(input)) return valueText(input, names);
  const fields = Object.entries(input).map(([name, shape]) =>
    typeof shape !== "function" && shape.kind === Wrapper.Optional
      ? `${propertyName(name)}?: ${valueText(shape.inner, names)}`
      : `${propertyName(name)}: ${valueText(shape, names)}`,
  );
  return `{ ${fields.join("; ")} }`;
}

/** What a start gives on its path: its input, or one value per field of its map (a tuple). */
export function startOutputText(input: WorkflowStartInput, names: ImportTable): string {
  if (isValueShape(input)) return valueText(input, names);
  return `readonly [${Object.values(input)
    .map((shape) => valueText(shape, names))
    .join(", ")}]`;
}

/**
 * An input field read from the path scope: `Produced<T, P>`, a list of them for a list field,
 * `HistoryOf<Produced<T, P>>` for a `historyOf(T)` field (#299 S56).
 */
export function producedText(
  shape: InputFieldShape,
  producers: string,
  names: ImportTable,
): string {
  const inner =
    typeof shape !== "function" && shape.kind === Wrapper.Optional ? shape.inner : shape;
  const produced = names.use(TablesImport.Produced);
  if (typeof inner === "function") return `${produced}<${names.dto(inner)}, ${producers}>`;
  if (inner.kind === Wrapper.History) {
    const history = names.use(TablesImport.HistoryOf);
    return `${history}<${produced}<${names.dto(inner.dto)}, ${producers}>>`;
  }
  return `readonly ${produced}<${elementText(inner.element, names)}, ${producers}>[]`;
}
