import { validate } from "../dto/schema.js";
import type { DtoClass } from "../dto/types.js";
import type { ListWrapper } from "./dto-wrappers.js";

/** What a `@WorkflowFinish` gives (#1271): one DTO, or a list of them. */
export type FinishOutput = DtoClass | ListWrapper;

/** The classes a finish's values are: its DTO, or the list's element (all variants of a `oneOf`). */
export function outputClassesOf(output: FinishOutput): readonly DtoClass[] {
  if (typeof output === "function") return [output];
  const { element } = output;
  return typeof element === "function" ? [element] : element.variants;
}

/** The DTO a finish gives as itself; undefined for a list (its values are items, never that DTO). */
export const plainOutputClassOf = (output: FinishOutput): DtoClass | undefined =>
  typeof output === "function" ? output : undefined;

/** The classes of the items of a list output; none for a plain DTO. */
export const listItemClassesOf = (output: FinishOutput): readonly DtoClass[] =>
  typeof output === "function" ? [] : outputClassesOf(output);

/**
 * A finished execution's output, checked against a finish's `output` as it was given (plain values,
 * not the scope's `{ value, variant }`): an element of a `oneOf` list must fit one of its classes.
 * Throws the first `DtoValidationError`.
 */
export function validOutput(output: FinishOutput, value: unknown): unknown {
  if (typeof output === "function") return validate(output, value);
  const { element } = output;
  if (typeof element === "function") return validList(element, value);
  if (!Array.isArray(value)) return validate(element.variants[0], value);
  return (value as readonly unknown[]).map((item) => {
    for (const variant of element.variants) {
      try {
        return validate(variant, item);
      } catch {
        // the next class
      }
    }
    return validate(element.variants[0], item);
  });
}

function validList(element: DtoClass, value: unknown): unknown {
  // a list is checked element by element; a non-list is a plain DTO error naming the class
  return Array.isArray(value)
    ? (value as readonly unknown[]).map((item) => validate(element, item))
    : validate(element, value);
}
