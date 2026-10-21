import {
  access,
  classHeader,
  comment,
  entry,
  importLine,
  propertyKey,
  text,
} from "./openapi-format.js";
import type { OperationModel } from "./openapi-spec.js";
import { render } from "./plan.js";

/**
 * The API's injectable client: `services/<name>-api.service.ts`, class `<Name>ApiService` (an
 * `@Injectable` named by its role, #280), injected as the field named after it.
 */
export interface ApiNames {
  readonly title: string;
  readonly className: string;
  readonly field: string;
  readonly module: string;
}

const WIDTH = 100;

export function serviceSource(api: ApiNames, baseUrl: string, source: string): string {
  const line = `  readonly baseUrl = ${JSON.stringify(baseUrl)};`;
  return render("openapi/service.ts.tmpl", {
    title: api.title,
    pascal: api.className,
    source: comment(source),
    baseUrl: line.length <= WIDTH ? line : `  readonly baseUrl =\n    ${JSON.stringify(baseUrl)};`,
  });
}

export const inputTypeOf = (op: OperationModel): string => op.input?.name ?? "NoInputDto";
const outputTypeOf = (op: OperationModel): string =>
  op.output.kind === "text" ? "PlainTextDto" : op.output.model.name;

/** A path parameter in the URL: encoded, a number or a flag as its text. */
const encoded = (name: string, type: string): string => {
  const value = access("input", name);
  return `\${encodeURIComponent(${type === "number" || type === "boolean" ? `String(${value})` : value})}`;
};

/** `/pets/{id}` → a template literal with the input's path parameters filled in. */
function pathExpression(op: OperationModel): string {
  const types = new Map(
    op.params.filter((p) => p.in === "path").map((p) => [p.field.name, p.field.type]),
  );
  if (types.size === 0) return JSON.stringify(op.path);
  const escaped = op.path.replace(/[`\\]|\$\{/g, (match) => `\\${match}`);
  const filled = escaped.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const type = types.get(name);
    return type === undefined ? match : encoded(name, type);
  });
  return `\`${filled}\``;
}

/** The `query` and `body` lines of the request. */
function requestLines(op: OperationModel): string {
  const query = op.params.filter((p) => p.in === "query").map((p) => p.field.name);
  const lines =
    query.length === 0
      ? []
      : [
          "      query: {",
          ...query.map((n) => `        ${propertyKey(n)}: ${access("input", n)},`),
          "      },",
        ];
  if (op.body !== undefined) lines.push(`      body: ${access("input", op.body.name)},`);
  return lines.map((line) => `${line}\n`).join("");
}

const ANSWERS = {
  object: (type: string) => `data as ${type}`,
  list: (type: string) => `{ items: data } as ${type}`,
  text: () => `{ text: typeof data === "string" ? data : JSON.stringify(data) }`,
} as const;

/** The framework DTOs a file needs: `NoInputDto`, `PlainTextDto`. */
const standardDtos = (types: readonly string[]): string[] =>
  types.filter((t) => t === "NoInputDto" || t === "PlainTextDto");

const dtoImport = (op: OperationModel, names: readonly string[]): string =>
  names.length === 0 ? "" : `\n${importLine(names, `./${op.names.kebab}.dto.js`)}`;

export function toolSource(op: OperationModel, api: ApiNames): string {
  const input = inputTypeOf(op);
  const output = outputTypeOf(op);
  const standard = standardDtos([input, output]);
  const own = [input, output].filter((t) => !standard.includes(t));
  const imports = [
    ...(standard.length === 0 ? [] : [importLine(standard, "agboss/dto")]),
    importLine([api.className], `../services/${api.module}.service.js`),
  ].join("\n");
  return render("openapi/tool.ts.tmpl", {
    imports: imports + dtoImport(op, own),
    summary: op.summary,
    method: op.method,
    path: comment(op.path),
    options: [
      entry(2, "name", JSON.stringify(`${op.names.kebab}-tool`)),
      entry(2, "description", text(op.summary)),
      entry(2, "input", input),
      entry(2, "output", output),
    ].join("\n"),
    api: api.className,
    apiField: api.field,
    header: classHeader(`${op.names.pascal}Tool`, input, output),
    parameters: op.input === undefined ? "" : `input: ${input}`,
    output,
    pathExpression: pathExpression(op),
    request: requestLines(op),
    answer: ANSWERS[op.output.kind](output),
  });
}
