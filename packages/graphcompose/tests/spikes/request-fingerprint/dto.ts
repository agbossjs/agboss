import { z } from "zod";
import type { JsonValue } from "./canonical-json.js";

/**
 * Spike #115 — just enough of the #118 DTO field decorators to test that the JSON Schema a DTO
 * class produces is deterministic. Not the #118 design: no compile-time field-type checks.
 *
 * Fields are collected with `context.addInitializer` on a probe instance, NOT `context.metadata`:
 * `context.metadata` exists under esbuild (vitest, tsx) but is `undefined` in `tsc` output on
 * Node 24/26 (no `Symbol.metadata`), so metadata-based DTOs would pass tests and break when built.
 */

/** Options every field decorator takes; `sensitive` is a PII action and never reaches the model. */
export interface FieldOptions {
  readonly prompt: string;
  readonly optional?: boolean;
  readonly example?: JsonValue;
  readonly default?: JsonValue;
  readonly sensitive?: "redact" | "mask";
}

export interface TextOptions extends FieldOptions {
  readonly maxLength?: number;
}

export interface IntegerOptions extends FieldOptions {
  readonly min?: number;
  readonly max?: number;
}

export interface OneOfOptions extends FieldOptions {
  readonly values: readonly [string, ...string[]];
}

/** A DTO class: data only, constructed without arguments. */
export type DtoClass = new () => object;

type FieldDecorator = (value: undefined, context: ClassFieldDecoratorContext) => void;

interface FieldSpec {
  readonly name: string;
  readonly type: z.ZodType;
  readonly options: FieldOptions;
}

let collecting: FieldSpec[] | undefined;

function field(type: z.ZodType, options: FieldOptions): FieldDecorator {
  return (_value, context) => {
    const name = String(context.name);
    context.addInitializer(() => {
      collecting?.push({ name, type, options });
    });
  };
}

export const Text = (options: TextOptions): FieldDecorator =>
  field(options.maxLength === undefined ? z.string() : z.string().max(options.maxLength), options);

export const Integer = (options: IntegerOptions): FieldDecorator => {
  const base = z.int();
  const withMin = options.min === undefined ? base : base.min(options.min);
  return field(options.max === undefined ? withMin : withMin.max(options.max), options);
};

export const OneOf = (options: OneOfOptions): FieldDecorator =>
  field(z.enum(options.values), options);

export const ListOfText = (options: FieldOptions): FieldDecorator =>
  field(z.array(z.string()), options);

function fieldSchema({ type, options }: FieldSpec): z.ZodType {
  const described = type.describe(options.prompt);
  const withExample =
    options.example === undefined ? described : described.meta({ examples: [options.example] });
  if (options.default !== undefined) return withExample.default(options.default);
  return options.optional === true ? withExample.optional() : withExample;
}

const schemas = new WeakMap<DtoClass, z.ZodObject>();

/** The zod object of a DTO, fields in declaration order. */
export function schemaOf(dto: DtoClass): z.ZodObject {
  const known = schemas.get(dto);
  if (known !== undefined) return known;
  collecting = [];
  new dto(); // runs the field initializers once, in declaration order
  const fields = collecting;
  collecting = undefined;
  const schema = z.object(Object.fromEntries(fields.map((spec) => [spec.name, fieldSchema(spec)])));
  schemas.set(dto, schema);
  return schema;
}
