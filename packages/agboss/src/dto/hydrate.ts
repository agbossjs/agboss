import { isOpen, registerDto } from "./metadata.js";
import { isDtoOrPlainObject } from "./plain.js";
import type { DtoClass, FieldSpec } from "./types.js";

/**
 * Prototype hydration (#1288): a validated or restored DTO value is a plain object whose prototype
 * is the class's own — `item instanceof XDto` and `item.constructor` hold wherever the value is read
 * (a validated answer, a scope read after a resume, a test input). No `new XDto()` on this path, and
 * no freeze: only the prototype is set, the fields stay as they are.
 */

function hydratedField(field: FieldSpec, value: unknown): unknown {
  const element = field.element;
  if (element?.kind !== "dto" || value === undefined || value === null) return value;
  return Array.isArray(value)
    ? value.map((item: unknown) => hydrated(element.dto, item))
    : hydrated(element.dto, value);
}

/**
 * A plain value of a DTO (a checkpoint's JSON, a test's literal) as a hydrated copy, nested DTOs and
 * lists of them included. Anything that is no plain object (a `Date`, a primitive) is returned as it is.
 */
export function hydrated(dto: DtoClass, value: unknown): unknown {
  if (isOpen(dto) || !isDtoOrPlainObject(value)) return value;
  // already an instance of the class (a validated value, a tracked one): kept, so what is recorded about it stays
  if (Object.getPrototypeOf(value) === dto.prototype) return value;
  const fields = registerDto(dto);
  const copy: Record<string, unknown> = Object.create(dto.prototype as object) as Record<
    string,
    unknown
  >;
  for (const [key, item] of Object.entries(value)) copy[key] = item;
  for (const field of fields) {
    if (field.name in copy) copy[field.name] = hydratedField(field, copy[field.name]);
  }
  return copy;
}

/** Sets the class's prototype on a value zod has just built (fresh, owned by the parse). */
export function hydrateInPlace(dto: DtoClass, value: Record<string, unknown>): void {
  Object.setPrototypeOf(value, dto.prototype as object);
}
