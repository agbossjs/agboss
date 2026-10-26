import { METADATA_KEY } from "../polyfills/symbol-metadata.js";
import { DtoError } from "./errors.js";
import type { DtoClass, FieldSpec } from "./types.js";

type FieldTable = Map<string, FieldSpec>;

/** Each class's own fields (in declaration order), keyed by its decorator metadata object. */
const tables = new WeakMap<object, FieldTable>();

function ownTable(metadata: DecoratorMetadataObject): FieldTable {
  const existing = tables.get(metadata);
  if (existing !== undefined) return existing;
  const table: FieldTable = new Map();
  tables.set(metadata, table);
  return table;
}

/** Called by every field decorator at class definition. */
export function recordField(metadata: DecoratorMetadataObject | undefined, spec: FieldSpec): void {
  if (metadata === undefined) {
    throw new DtoError(
      "dto.no-metadata",
      `field "${spec.name}": decorator metadata is missing — import "@agboss/core/dto" before declaring DTOs`,
    );
  }
  ownTable(metadata).set(spec.name, spec);
}

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

/** A DTO's fields — its parents' first, then its own — in declaration order. */
export function fieldsOf(dto: DtoClass): readonly FieldSpec[] {
  const chain: FieldTable[] = [];
  let metadata: unknown = Reflect.get(dto, METADATA_KEY);
  while (isObject(metadata)) {
    const own = tables.get(metadata);
    if (own !== undefined) chain.unshift(own);
    metadata = Object.getPrototypeOf(metadata);
  }
  return chain.flatMap((table) => [...table.values()]);
}

/** DTOs that hold any JSON object (internal: tool arguments). */
const openDtos = new WeakSet<DtoClass>();
export const markOpen = (dto: DtoClass): void => {
  openDtos.add(dto);
};
export const isOpen = (dto: DtoClass): boolean => openDtos.has(dto);

/** Methods and accessors anywhere up the prototype chain (a DTO has none). */
function behaviourOf(dto: DtoClass): string[] {
  const names: string[] = [];
  for (let proto: unknown = dto.prototype; isObject(proto) && proto !== Object.prototype;) {
    names.push(...Object.getOwnPropertyNames(proto).filter((name) => name !== "constructor"));
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

const registered = new WeakSet<DtoClass>();

/**
 * The startup check of a DTO class (once per class): every own field is decorated, and the class is
 * plain data — no methods, accessors or `#private` fields. Needs `useDefineForClassFields` (ES2022+).
 */
export function registerDto(dto: DtoClass): readonly FieldSpec[] {
  const fields = fieldsOf(dto);
  if (registered.has(dto)) return fields;
  const decorated = new Set(fields.map((field) => field.name));
  const instance: unknown = Reflect.construct(dto, []);
  const undecorated = Object.keys(isObject(instance) ? instance : {}).filter(
    (key) => !decorated.has(key),
  );
  if (undecorated.length > 0) {
    throw new DtoError(
      "dto.undecorated-field",
      `${dto.name}: every field needs a field decorator — ${undecorated.join(", ")}`,
    );
  }
  const notPlain = [
    ...behaviourOf(dto),
    ...fields.filter((field) => field.isPrivate).map((field) => field.name),
  ];
  if (notPlain.length > 0) {
    throw new DtoError(
      "dto.not-plain-data",
      `${dto.name}: a DTO is plain data, without methods or private fields — ${notPlain.join(", ")}`,
    );
  }
  registered.add(dto);
  return fields;
}
