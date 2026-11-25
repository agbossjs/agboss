import { z } from "zod";
import { dtoCycleOf, cycleText } from "./cycles.js";
import { pathOf, dtoClassError, invalidDto } from "./errors.js";
import { scalarSchemas } from "./formats.js";
import { checksOf, isOpen, registerDto } from "./metadata.js";
import { hydrateInPlace } from "./hydrate.js";
import { rememberDtoOf } from "./redact.js";
import type { DtoCheck, DtoClass, ElementSpec, FieldSpec } from "./types.js";

const FAILED = "validation failed";

interface Issue {
  readonly field?: string;
  readonly reason: string;
}

/** One reported issue: a message, or a message at a field; anything else is a failure. */
function issueOf(one: unknown): Issue {
  if (typeof one === "string") return { reason: one === "" ? FAILED : one };
  if (typeof one === "object" && one !== null && "reason" in one) {
    const { field, reason } = one as { field?: unknown; reason: unknown };
    return {
      ...(typeof field === "string" ? { field } : {}),
      reason: typeof reason === "string" && reason !== "" ? reason : FAILED,
    };
  }
  return { reason: FAILED };
}

/** What a check returned, as issues: `undefined`, `true` and `[]` are valid; `false` and the unexpected fail. */
function issuesOf(result: unknown): readonly Issue[] {
  if (result === undefined || result === true) return [];
  return Array.isArray(result) ? result.map(issueOf) : [issueOf(result)];
}

/** Runs one check; a check that throws, or returns something it should not (a Promise), fails. */
function runCheck(check: DtoCheck<never>, value: Record<string, unknown>): readonly Issue[] {
  try {
    return issuesOf((check as (v: unknown) => unknown)(value));
  } catch {
    return [{ reason: FAILED }];
  }
}

type ObjectSchema = z.ZodType<Record<string, unknown>>;
const schemas = new WeakMap<DtoClass, ObjectSchema>();

const elementSchema = (element: ElementSpec | undefined): z.ZodType => {
  if (element === undefined) return z.unknown();
  if (element.kind === "enum") return z.enum(element.values);
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

/** What a DTO that holds itself is told (a cycle has no finite JSON Schema, and no finite value of its own). */
export const cyclicMessage = (cycle: readonly DtoClass[]): string =>
  `a DTO cannot reference itself, directly or through other DTOs: ${cycleText(cycle)} — break the cycle (an id field, or a flat list)`;

/** A DTO as an object schema (registered first: undecorated fields and behaviour fail here). */
export function objectSchemaOf(dto: DtoClass): ObjectSchema {
  const cached = schemas.get(dto);
  if (cached !== undefined) return cached;
  if (isOpen(dto)) return z.record(z.string(), z.unknown());
  const fields = registerDto(dto);
  const cycle = dtoCycleOf(dto);
  if (cycle !== undefined)
    throw dtoClassError({ code: "dto.cyclic", message: cyclicMessage(cycle) });
  const checks = checksOf(dto);
  const schema = fieldsSchemaOf(fields)
    .superRefine((value, ctx) => {
      for (const check of checks) {
        for (const issue of runCheck(check, value)) {
          ctx.addIssue({
            code: "custom",
            path: issue.field === undefined ? [] : [issue.field],
            message: issue.reason,
          });
        }
      }
    })
    // the value of a DTO carries the DTO's prototype (#1288); zod built it, nothing else holds it yet
    .check(
      z.overwrite((value: Record<string, unknown>) => {
        hydrateInPlace(dto, value);
        return value;
      }),
    );
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
export const jsonSchemaOf = (dto: DtoClass): Readonly<Record<string, unknown>> =>
  inputJsonSchema(schemaOf(dto));

/** Checks raw data against a DTO: the parsed value, or every issue with its path and reason. */
export function validate<T extends object>(dto: DtoClass<T>, raw: unknown): T {
  const parsed = schemaOf(dto).safeParse(raw);
  if (parsed.success) return parsed.data;
  throw invalidDto({
    dto: dto.name,
    issues: parsed.error.issues.map((issue) => ({
      path: pathOf(issue.path),
      reason: issue.message,
    })),
  });
}

const strictSchemas = new WeakMap<DtoClass, z.ZodType>();

function strictSchemaOf(dto: DtoClass): z.ZodType {
  const cached = strictSchemas.get(dto);
  if (cached !== undefined) return cached;
  const base = objectSchemaOf(dto);
  const strict = base instanceof z.ZodObject ? base.strict() : base;
  strictSchemas.set(dto, strict);
  return strict;
}

/**
 * The class a plain value is, by strict validation: the first of `dtos` whose strict schema (no
 * field it does not declare) accepts it. Assembly refuses polymorphic outputs where two classes
 * could accept one value (`[dto.ambiguous-one-of]`), so the first match is the only one.
 */
export function strictMatchOf(dtos: readonly DtoClass[], value: unknown): DtoClass | undefined {
  return dtos.find((dto) => strictSchemaOf(dto).safeParse(value).success);
}
