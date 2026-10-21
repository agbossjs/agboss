import { resolve } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3 } from "openapi-types";
import { ScaffoldError } from "./errors.js";
import { namesOf, type Names } from "./names.js";
import {
  DtoSet,
  flatten,
  isSchema,
  type ClassModel,
  type FieldModel,
  type Schema,
} from "./openapi-dto.js";
import { comment } from "./openapi-format.js";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

/** A parameter of the operation's input DTO: where it goes in the request. */
export interface ParamModel {
  readonly in: "path" | "query";
  readonly field: FieldModel;
}

/** What the tool answers: the response DTO, the response list under `items`, or the raw text. */
export type OutputModel =
  { readonly kind: "object" | "list"; readonly model: ClassModel } | { readonly kind: "text" };

/** One operation of the document, as one tool. */
export interface OperationModel {
  readonly names: Names;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  /** Every DTO class of the operation's `.dto.ts` file, in order. */
  readonly classes: readonly ClassModel[];
  /** undefined → the tool takes `NoInputDto`. */
  readonly input: ClassModel | undefined;
  readonly params: readonly ParamModel[];
  readonly body: FieldModel | undefined;
  readonly output: OutputModel;
}

const isHttp = (url: string): boolean => /^https?:\/\//i.test(url);

/** The document behind `--url` (a URL or a file of the project), every `$ref` resolved. */
export async function loadDocument(root: string, url: string): Promise<OpenAPIV3.Document> {
  let document: unknown;
  try {
    document = await SwaggerParser.dereference(isHttp(url) ? url : resolve(root, url));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ScaffoldError(`Cannot read the OpenAPI document ${url}: ${reason}`);
  }
  const version = (document as { openapi?: unknown }).openapi;
  if (typeof version !== "string" || !version.startsWith("3."))
    throw new ScaffoldError(`${url}: only OpenAPI 3.x documents are supported`);
  return document as OpenAPIV3.Document;
}

/** The first server's URL, its variables at their defaults; a relative one is resolved. */
export function baseUrlOf(document: OpenAPIV3.Document, url: string): string {
  const server = document.servers?.[0];
  if (server === undefined) return "http://localhost";
  const raw = server.url.replace(
    /\{(\w+)\}/g,
    (_match, name: string) => server.variables?.[name]?.default ?? name,
  );
  return new URL(raw, isHttp(url) ? url : "http://localhost").toString().replace(/\/+$/, "");
}

const parametersOf = (
  ...lists: (readonly unknown[] | undefined)[]
): Map<string, OpenAPIV3.ParameterObject> => {
  const all = new Map<string, OpenAPIV3.ParameterObject>();
  for (const parameter of lists.flatMap((list) => list ?? [])) {
    const p = parameter as OpenAPIV3.ParameterObject;
    if (p.in === "path" || p.in === "query") all.set(`${p.in}:${p.name}`, p);
  }
  return all;
};

const TEXT: Schema = { type: "string" };
const SCALARS: readonly unknown[] = ["string", "integer", "number", "boolean"];

/** A parameter the URL can carry: a plain value, or (in the query) a list of them. */
const plain = (schema: unknown, list: boolean): schema is Schema =>
  isSchema(schema) &&
  (SCALARS.includes(schema.type) ||
    (list &&
      schema.type === "array" &&
      isSchema(schema.items) &&
      SCALARS.includes(schema.items.type)));

function paramsOf(
  dtos: DtoSet,
  owner: string,
  path: string,
  parameters: Map<string, OpenAPIV3.ParameterObject>,
): ParamModel[] {
  for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
    if (name !== undefined && !parameters.has(`path:${name}`))
      parameters.set(`path:${name}`, { name, in: "path", required: true });
  }
  return [...parameters.values()].flatMap((p) => {
    const required = p.in === "path" || p.required === true;
    const schema = plain(p.schema, p.in === "query") ? p.schema : TEXT;
    const describe = { ...schema, description: p.description };
    const field =
      dtos.field(owner, p.name, describe, required) ?? dtos.field(owner, p.name, TEXT, required);
    return field === undefined ? [] : [{ in: p.in as "path" | "query", field }];
  });
}

const jsonSchemaOf = (content: OpenAPIV3.ResponseObject["content"]): Schema | undefined => {
  const json = Object.entries(content ?? {}).find(([type]) => type.includes("json"));
  return isSchema(json?.[1].schema) ? flatten(json[1].schema) : undefined;
};

function bodyOf(
  dtos: DtoSet,
  owner: string,
  op: OpenAPIV3.OperationObject,
  name: string,
): FieldModel | undefined {
  const request = op.requestBody as OpenAPIV3.RequestBodyObject | undefined;
  const schema = jsonSchemaOf(request?.content);
  if (schema === undefined) return undefined;
  const described = {
    ...schema,
    description: schema.description ?? request?.description ?? "the request body",
  };
  return dtos.field(owner, name, described, request?.required === true);
}

/** A list answer becomes `{ items }`: a tool answers an object. */
const listed = (schema: Schema, description: string | undefined): Schema => ({
  type: "object",
  required: ["items"],
  properties: { items: { ...schema, description: description ?? "the items" } },
});

function outputOf(
  op: OpenAPIV3.OperationObject,
  pascal: string,
  snake: string,
): OutputModel & { readonly classes: readonly ClassModel[] } {
  const dtos = new DtoSet("output");
  const [code] = Object.keys(op.responses)
    .filter((c) => /^2\d\d$/.test(c))
    .sort();
  const response = op.responses[code ?? ""] as OpenAPIV3.ResponseObject | undefined;
  const schema = jsonSchemaOf(response?.content);
  if (schema === undefined) return { kind: "text", classes: [] };
  const list = schema.type === "array";
  const model = dtos.object(
    `${pascal}Output`,
    list ? listed(schema, response?.description) : schema,
    `What ${snake}-tool answers.`,
  );
  if (model === undefined) return { kind: "text", classes: [] };
  return { kind: list ? "list" : "object", model, classes: dtos.classes };
}

function operationOf(
  path: string,
  method: string,
  op: OpenAPIV3.OperationObject,
  shared: readonly unknown[] | undefined,
): OperationModel {
  const names = namesOf(op.operationId ?? `${method} ${path}`);
  const summary = comment(op.summary ?? op.description ?? names.title);
  const dtos = new DtoSet("input");
  const params = paramsOf(dtos, names.pascal, path, parametersOf(shared, op.parameters));
  const bodyName = params.some((p) => p.field.name === "body") ? "requestBody" : "body";
  const body = bodyOf(dtos, names.pascal, op, bodyName);
  const fields = [...params.map((p) => p.field), ...(body === undefined ? [] : [body])];
  const input =
    fields.length === 0
      ? undefined
      : dtos.add(`${names.pascal}Input`, `What the model sends to ${names.kebab}-tool.`, fields);
  const { classes: outputClasses, ...output } = outputOf(op, names.pascal, names.kebab);
  return {
    names,
    method: method.toUpperCase(),
    path,
    summary,
    classes: [...dtos.classes, ...outputClasses],
    input,
    params,
    body,
    output,
  };
}

/** Every operation of the document, one tool each. */
export function operationsOf(document: OpenAPIV3.Document): OperationModel[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const op = item?.[method];
      return op === undefined ? [] : [operationOf(path, method, op, item?.parameters)];
    }),
  );
}
