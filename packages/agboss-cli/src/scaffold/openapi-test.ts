import { sampleOf } from "./openapi-dto.js";
import { access, importLine, literal, type Sample } from "./openapi-format.js";
import type { OperationModel } from "./openapi-spec.js";
import { inputTypeOf } from "./openapi-tool.js";
import { render } from "./plan.js";

const WIDTH = 100;

/** A path or query sample as the URL carries it (they are plain values). */
const plainText = (value: Sample): string =>
  typeof value === "object" ? JSON.stringify(value) : String(value);

/** The URL the generated test expects for the sample input — built the way the client builds it. */
function expectedUrl(
  op: OperationModel,
  baseUrl: string,
  input: Readonly<Record<string, Sample>>,
): string {
  const path = op.path.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const value = input[name];
    return value === undefined ? match : encodeURIComponent(plainText(value));
  });
  const url = new URL(`${baseUrl}${path}`);
  for (const p of op.params.filter((q) => q.in === "query")) {
    const value = input[p.field.name];
    const items = value === undefined ? [] : [value].flat();
    for (const item of items) url.searchParams.append(p.field.name, plainText(item));
  }
  return url.toString();
}

/** What the stubbed API answers: a sample of the output DTO, an empty list, or text. */
const answerOf = (op: OperationModel): string => {
  if (op.output.kind === "text") return JSON.stringify("ok");
  return op.output.kind === "list" ? "[]" : literal(sampleOf(op.output.model), 4);
};

const typeImportOf = (op: OperationModel): string =>
  op.input === undefined
    ? importLine(["NoInputDto"], "agboss/dto", true)
    : importLine([op.input.name], `./${op.names.kebab}.dto.js`, true);

/** The tool's test: the API stubbed, the sample input sent, the request checked. */
export function testSource(op: OperationModel, baseUrl: string): string {
  const input = op.input === undefined ? {} : sampleOf(op.input);
  const url = JSON.stringify(expectedUrl(op, baseUrl, input));
  const urlCheck = `    expect(calls[0]?.url).toBe(${url});`;
  const body = op.body;
  return render("openapi/tool.test.ts.tmpl", {
    imports: [
      typeImportOf(op),
      importLine([`${op.names.pascal}Tool`], `./${op.names.kebab}.tool.js`),
    ].join("\n"),
    snake: op.names.snake,
    method: op.method,
    answer: answerOf(op),
    inputType: inputTypeOf(op),
    input: literal(input, 4),
    pascal: op.names.pascal,
    urlCheck:
      urlCheck.length <= WIDTH
        ? urlCheck
        : `    expect(calls[0]?.url).toBe(\n      ${url},\n    );`,
    bodyCheck:
      body === undefined || body.optional
        ? ""
        : `    expect(calls[0]?.init.body).toBe(JSON.stringify(${access("input", body.name)}));\n`,
  });
}
