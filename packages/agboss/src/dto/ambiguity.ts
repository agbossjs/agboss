import { fieldsOf } from "./metadata.js";
import type { DtoClass, ElementSpec, FieldSpec } from "./types.js";

/**
 * Whether one plain value could be accepted by the strict schemas (no undeclared field) of two DTOs.
 * It could unless a required field of one is unknown to the other, or a field both declare cannot
 * hold the same value (another kind, an enum with no value in common, another nested class).
 */

const isRequired = (field: FieldSpec): boolean =>
  !field.optional && field.settings.default === undefined;

/** Whether two element specs of a field can hold no value in common. */
function elementsConflict(x: ElementSpec | undefined, y: ElementSpec | undefined): boolean {
  if (x === undefined || y === undefined) return x !== y;
  if (x.kind === "dto") return y.kind !== "dto" || x.dto !== y.dto;
  if (x.kind === "scalar") return y.kind !== "scalar" || x.scalar !== y.scalar;
  return y.kind !== "enum" || !shareValue(x.values, y.values);
}

const shareValue = (a: readonly string[], b: readonly string[]): boolean => {
  const mine = new Set(a);
  return b.some((value) => mine.has(value));
};

/** Whether two fields of one name can hold no value in common. */
function conflict(a: FieldSpec, b: FieldSpec): boolean {
  if (a.kind !== b.kind) return true;
  if (a.kind === "one-of") return !shareValue(a.settings.values ?? [], b.settings.values ?? []);
  return elementsConflict(a.element, b.element);
}

/** Whether a value could be both an `a` and a `b` under their strict schemas. */
export function canBeBoth(a: DtoClass, b: DtoClass): boolean {
  const [fieldsA, fieldsB] = [fieldsOf(a), fieldsOf(b)];
  const byNameA = new Map(fieldsA.map((field) => [field.name, field]));
  const byNameB = new Map(fieldsB.map((field) => [field.name, field]));
  const lacks = (fields: readonly FieldSpec[], others: ReadonlyMap<string, FieldSpec>): boolean =>
    fields.some((field) => isRequired(field) && !others.has(field.name));
  if (lacks(fieldsA, byNameB) || lacks(fieldsB, byNameA)) return false;
  return !fieldsA.some((field) => {
    const other = byNameB.get(field.name);
    return other !== undefined && conflict(field, other);
  });
}

/** The first two of `dtos` a value could be both of; none when every pair is distinguishable. */
export function ambiguousPairOf(
  dtos: readonly DtoClass[],
): readonly [DtoClass, DtoClass] | undefined {
  for (const [at, first] of dtos.entries()) {
    for (const second of dtos.slice(at + 1)) {
      if (canBeBoth(first, second)) return [first, second];
    }
  }
  return undefined;
}
