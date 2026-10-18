import { z } from "zod";
import { DtoValidationError, pathOf } from "./errors.js";
import { scalarSchemas } from "./formats.js";
import { isOpen, registerDto } from "./metadata.js";
import { rememberDtoOf } from "./redact.js";
import type { DtoClass, ElementSpec, FieldSpec } from "./types.js";

/** A rule across fields that one decorator cannot say (`from` ≤ `to`); `undefined` = fine. */
export type CrossFieldRule<T> = (
  value: T,
) => { readonly field: string; readonly reason: string } | undefined;

const rules = new WeakMap<DtoClass, readonly CrossFieldRule<Record<string, unknown>>[]>();

/** Adds a cross-field rule to a DTO's validation (standard DTOs; checked after the fields). */
export function crossFieldRule<T extends object>(dto: DtoClass<T>, rule: CrossFieldRule<T>): void {
  // the rule reads the DTO's own fields, which validation has already checked
  const loose = rule as unknown as CrossFieldRule<Record<string, unknown>>;
  rules.set(dto, [...(rules.get(dto) ?? []), loose]);
}

type ObjectSchema = z.ZodType<Record<string, unknown>>;
const schemas = new WeakMap<DtoClass, ObjectSchema>();

const elementSchema = (element: ElementSpec | undefined): z.ZodType => {
  if (element === undefined) return z.unknown();
  return element.kind === "dto" ? objectSchemaOf(element.dto) : scalarSchemas[element.scalar]({});
};

function valueSchema(field: FieldSpec): z.ZodType {
  const { settings } = field;
  switch (field.kind) {
    case "one-of":
      return z.enum(settings.values ?? []);
    case "nested":
      return elementSchema(field.element);
    case "list-of": {
      let list = z.array(elementSchema(field.element));
      if (settings.minItems !== undefined) list = list.min(settings.minItems);
      if (settings.maxItems !== undefined) list = list.max(settings.maxItems);
      return list;
    }
    default:
      return scalarSchemas[field.kind](settings);
  }
}

/** One field: its value, optional or defaulted, with what the model reads. */
function fieldSchema(field: FieldSpec): z.ZodType {
  const { settings } = field;
  const value = valueSchema(field);
  const shaped = field.optional
    ? value.optional()
    : settings.default === undefined
      ? value
      : value.default(settings.default);
  const meta = {
    ...(settings.prompt === undefined ? {} : { description: settings.prompt }),
    ...(settings.example === undefined ? {} : { examples: [settings.example] }),
  };
  return Object.keys(meta).length === 0 ? shaped : shaped.meta(meta);
}

/** An object of these fields, each checked by its decorator (internal: DTOs and contexts). */
export const fieldsSchemaOf = (fields: readonly FieldSpec[]): z.ZodObject =>
  z.object(Object.fromEntries(fields.map((field) => [field.name, fieldSchema(field)])));

/** A DTO as an object schema (registered first: undecorated fields and behaviour fail here). */
export function objectSchemaOf(dto: DtoClass): ObjectSchema {
  const cached = schemas.get(dto);
  if (cached !== undefined) return cached;
  if (isOpen(dto)) return z.record(z.string(), z.unknown());
  const fields = registerDto(dto);
  const own = rules.get(dto) ?? [];
  const schema = fieldsSchemaOf(fields).superRefine((value, ctx) => {
    for (const rule of own) {
      const broken = rule(value);
      if (broken !== undefined) {
        ctx.addIssue({ code: "custom", path: [broken.field], message: broken.reason });
      }
    }
  });
  schemas.set(dto, schema);
  rememberDtoOf(schema, dto);
  return schema;
}

/** The runtime check of a DTO (internal; zod stays inside the framework). */
export function schemaOf<T extends object>(dto: DtoClass<T>): z.ZodType<T> {
  // built from T's own decorators, so what it accepts is T
  return objectSchemaOf(dto) as unknown as z.ZodType<T>;
}

/** A JSON Schema of what a model may send: `io: "input"`, no `$schema` (#115). */
export type JsonSchema = Readonly<Record<string, unknown>>;

export function inputJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: "input" });
  delete json.$schema;
  return json;
}

/** The JSON Schema the model sees for a DTO: fields in declaration order, `description` = `prompt`. */
export const jsonSchemaOf = (dto: DtoClass): JsonSchema => inputJsonSchema(schemaOf(dto));

/** Checks raw data against a DTO: the parsed value, or every issue with its path and reason. */
export function validate<T extends object>(dto: DtoClass<T>, raw: unknown): T {
  const parsed = schemaOf(dto).safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new DtoValidationError(
    dto.name,
    parsed.error.issues.map((issue) => ({ path: pathOf(issue.path), reason: issue.message })),
  );
}
