import type { OpenAPIV3 } from "openapi-types";
import { ScaffoldError } from "./errors.js";
import { namesOf } from "./names.js";
import { call, comment, importLine, propertyKey, text, type Sample } from "./openapi-format.js";

export type Schema = OpenAPIV3.SchemaObject;

/** One DTO field read from a schema: its decorator, TypeScript type and a sample value. */
export interface FieldModel {
  readonly name: string;
  readonly decorator: string;
  /** The decorator's first argument: `@ListOf(Text, …)`, `@Nested(Pet, …)`. */
  readonly lead?: string;
  readonly values?: readonly string[];
  readonly type: string;
  readonly prompt: string;
  readonly optional: boolean;
  readonly sample: Sample;
}

export interface ClassModel {
  readonly name: string;
  readonly doc: string;
  readonly fields: readonly FieldModel[];
}

type Kind = Pick<FieldModel, "decorator" | "lead" | "values" | "type" | "sample">;

const MAX_DEPTH = 5;

/** A schema object (the document is dereferenced; a `$ref` left over is a cycle — not mapped). */
export const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !("$ref" in value);

/** `allOf` parts merged into one object schema (their properties and required names). */
export function flatten(schema: Schema): Schema {
  const parts = (schema.allOf ?? []).filter(isSchema).map(flatten);
  if (parts.length === 0) return schema;
  const properties: NonNullable<Schema["properties"]> = { ...schema.properties };
  for (const part of parts) Object.assign(properties, part.properties);
  return {
    ...schema,
    type: "object",
    properties,
    required: [...(schema.required ?? []), ...parts.flatMap((p) => p.required ?? [])],
  };
}

const FORMATS: Readonly<Record<string, readonly [string, string]>> = {
  "date-time": ["DateTime", "2026-01-01T00:00:00Z"],
  email: ["Email", "user@example.com"],
  uri: ["Url", "https://example.com"],
  url: ["Url", "https://example.com"],
  uuid: ["Uuid", "00000000-0000-4000-8000-000000000000"],
};

function stringKind(schema: Schema): Kind {
  const values = (schema.enum ?? []).filter((v): v is string => typeof v === "string");
  const [first] = values;
  if (first !== undefined) {
    return {
      decorator: "OneOf",
      values,
      type: values.map((v) => JSON.stringify(v)).join(" | "),
      sample: first,
    };
  }
  const [decorator, sample] = FORMATS[schema.format ?? ""] ?? ["Text", "example"];
  return { decorator, type: "string", sample };
}

/** A plain value's decorator: Text (or a format), OneOf, Integer, Decimal, Flag. */
function scalarKind(schema: Schema): Kind | undefined {
  if (schema.type === "string") return stringKind(schema);
  if (schema.type === "integer") return { decorator: "Integer", type: "number", sample: 1 };
  if (schema.type === "number") return { decorator: "Decimal", type: "number", sample: 1 };
  if (schema.type === "boolean") return { decorator: "Flag", type: "boolean", sample: true };
  return undefined;
}

const pascalOf = (raw: string): string => {
  try {
    return namesOf(raw).pascal;
  } catch (error) {
    if (error instanceof ScaffoldError) return "Field";
    throw error;
  }
};

/**
 * The DTO classes of one operation's file. Nested classes come before the classes that use them
 * (a decorator argument must be defined when the class is). `output` drops nullable fields: the
 * DTOs have no null, and a field the DTO leaves out is ignored, not rejected.
 */
export class DtoSet {
  readonly classes: ClassModel[] = [];

  constructor(private readonly mode: "input" | "output") {}

  /** A field for `schema`, or undefined when no DTO decorator expresses it. */
  field(
    owner: string,
    name: string,
    schema: unknown,
    required: boolean,
    depth = 0,
  ): FieldModel | undefined {
    if (!isSchema(schema) || (schema.nullable === true && this.mode === "output")) return undefined;
    const kind = this.kindOf(`${owner}${pascalOf(name)}`, flatten(schema), depth);
    if (kind === undefined) return undefined;
    const prompt = schema.description ?? schema.title ?? namesOf(pascalOf(name)).title;
    return { name, ...kind, prompt, optional: !required || schema.nullable === true };
  }

  /** A class for an object schema with properties; undefined when none of them maps. */
  object(name: string, schema: Schema, doc: string, depth = 0): ClassModel | undefined {
    if (depth > MAX_DEPTH) return undefined;
    schema = flatten(schema);
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {}).flatMap(([key, property]) => {
      const field = this.field(name, key, property, required.has(key), depth + 1);
      return field === undefined ? [] : [field];
    });
    return fields.length === 0 ? undefined : this.add(name, doc, fields);
  }

  add(name: string, doc: string, fields: readonly FieldModel[]): ClassModel {
    const taken = new Set(this.classes.map((c) => c.name));
    let unique = name;
    for (let n = 2; taken.has(unique); n += 1) unique = `${name}${String(n)}`;
    const model = { name: unique, doc, fields };
    this.classes.push(model);
    return model;
  }

  private kindOf(name: string, schema: Schema, depth: number): Kind | undefined {
    if (schema.type === "array") return this.listKind(name, schema.items, depth);
    if (schema.type === "object" || schema.properties !== undefined) {
      const nested = this.object(name, schema, comment(schema.description ?? name), depth);
      return (
        nested && {
          decorator: "Nested",
          lead: nested.name,
          type: nested.name,
          sample: sampleOf(nested),
        }
      );
    }
    return scalarKind(schema);
  }

  private listKind(name: string, raw: unknown, depth: number): Kind | undefined {
    if (!isSchema(raw)) return undefined;
    const items = flatten(raw);
    const scalar = scalarKind(items);
    if (scalar !== undefined) {
      const plain = scalar.decorator === "OneOf" ? { decorator: "Text", type: "string" } : scalar;
      return { decorator: "ListOf", lead: plain.decorator, type: `${plain.type}[]`, sample: [] };
    }
    if (items.type !== "object" && items.properties === undefined) return undefined;
    const item = this.object(`${name}Item`, items, comment(items.description ?? name), depth);
    return item && { decorator: "ListOf", lead: item.name, type: `${item.name}[]`, sample: [] };
  }
}

/** A sample instance: the required fields' samples. */
export const sampleOf = (model: ClassModel): Record<string, Sample> =>
  Object.fromEntries(model.fields.filter((f) => !f.optional).map((f) => [f.name, f.sample]));

function fieldSource(field: FieldModel): string {
  const options: (readonly [string, string])[] = [["prompt", text(field.prompt)]];
  if (field.values !== undefined)
    options.push(["values", `[${field.values.map((v) => JSON.stringify(v)).join(", ")}]`]);
  if (field.optional) options.push(["optional", "true"]);
  const decorator = call(
    2,
    `@${field.decorator}`,
    field.lead === undefined ? [] : [field.lead],
    options,
  );
  return `${decorator}\n  ${propertyKey(field.name)}${field.optional ? "?" : "!"}: ${field.type};`;
}

/** The kebab file stem of a DTO class (`GetPetInput` → `get-pet-input`). */
export const dtoFileStem = (className: string): string =>
  namesOf(className.replace(/Dto$/, "")).kebab;

/** One `<class>.dto.ts` file: the decorators and sibling DTOs it uses, then the class. */
export function dtoClassSource(model: ClassModel, allClasses: readonly ClassModel[]): string {
  const names = new Set(allClasses.map((c) => c.name));
  const scalars = model.fields.flatMap((f) =>
    f.decorator === "ListOf" && f.lead !== undefined && !names.has(f.lead) ? [f.lead] : [],
  );
  const decorators = [...new Set([...model.fields.map((f) => f.decorator), ...scalars])].sort();
  const siblingImports = [
    ...new Set(
      model.fields.flatMap((f) =>
        f.lead !== undefined && names.has(f.lead) && f.lead !== model.name ? [f.lead] : [],
      ),
    ),
  ]
    .sort()
    .map((ref) => importLine([ref], `./${dtoFileStem(ref)}.dto.js`));
  const imports = [importLine(decorators, "agboss/dto"), ...siblingImports].join("\n");
  const body = `/** ${model.doc} */\nexport class ${model.name} {\n${model.fields.map(fieldSource).join("\n\n")}\n}\n`;
  return `${imports}\n\n${body}`;
}
