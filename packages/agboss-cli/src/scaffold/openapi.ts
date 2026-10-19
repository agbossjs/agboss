import { ScaffoldError, ScaffoldUsageError } from "./errors.js";
import { namesOf } from "./names.js";
import { dtoSource } from "./openapi-dto.js";
import { baseUrlOf, loadDocument, operationsOf, type OperationModel } from "./openapi-spec.js";
import { testSource } from "./openapi-test.js";
import { serviceSource, toolSource, type ApiNames } from "./openapi-tool.js";
import { need, read } from "./project-files.js";
import { agentOf, importPath, workflowGraph } from "./workflow-graph.js";
import { wire } from "./wire.js";
import type { Changes, FileToWrite } from "./write.js";

export interface OpenApiOptions {
  readonly url?: string | undefined;
  readonly workflow?: string | undefined;
  readonly agent?: string | undefined;
  /** Comma-separated operationIds (or tool names); every operation when missing. */
  readonly operations?: string | undefined;
}

/** `pets` → `PetsApi` in `services/pets-api.service.ts` (a name already ending in "api" keeps it). */
function apiNamesOf(name: string): ApiNames {
  const base = namesOf(name);
  const api = /(^|_)api$/.test(base.snake) ? base : namesOf(`${name} api`);
  return { title: base.title, className: api.pascal, module: api.kebab };
}

/** The operations `--operations` names (by operationId or tool name), in its order. */
function selected(
  all: readonly OperationModel[],
  only: string | undefined,
): readonly OperationModel[] {
  if (only === undefined) return all;
  return only
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .map((name) => {
      const found = all.find((op) => op.names.snake === namesOf(name).snake);
      if (found === undefined) {
        const known = all.map((op) => op.names.snake).join(", ");
        throw new ScaffoldUsageError(`No operation "${name}" in the document — one of: ${known}`);
      }
      return found;
    });
}

/** One operation's files: its DTOs (when it has any), the tool and the tool's test. */
function operationFiles(
  dir: string,
  op: OperationModel,
  api: ApiNames,
  baseUrl: string,
): FileToWrite[] {
  const base = `${dir}/tools/${op.names.kebab}`;
  return [
    ...(op.classes.length === 0
      ? []
      : [{ path: `${base}.dto.ts`, content: dtoSource(op.classes) }]),
    { path: `${base}.tool.ts`, content: toolSource(op, api) },
    { path: `${base}.tool.test.ts`, content: testSource(op, baseUrl) },
  ];
}

/**
 * `agboss generate openapi <name> --url <document> --workflow <path> --agent <name>`: one tool per
 * operation (input and output DTOs, the request built from them, a test against a stubbed API),
 * one injectable client for the API registered in the workflow's providers, the tools wired into
 * the agent.
 */
export async function planOpenApi(
  root: string,
  name: string,
  options: OpenApiOptions,
): Promise<Changes> {
  const url = need(options.url, "--url <OpenAPI document: a file or a URL>", "openapi");
  const graph = workflowGraph(root, options.workflow, "openapi");
  const { dir, module } = graph;
  const agent = read(root, agentOf(graph, need(options.agent, "--agent <name>", "openapi")).path);
  const api = apiNamesOf(name);
  const document = await loadDocument(root, url);
  const operations = selected(operationsOf(document), options.operations);
  if (operations.length === 0) throw new ScaffoldError(`${url}: the document has no operations`);
  const baseUrl = baseUrlOf(document, url);
  const wired = operations.reduce(
    (file, op) =>
      wire(
        file,
        "Agent",
        "tools",
        `${op.names.pascal}Tool`,
        `${op.names.pascal}Tool`,
        importPath(agent.path, `${dir}/tools/${op.names.kebab}.tool.ts`),
      ),
    agent,
  );
  return {
    create: [
      {
        path: `${dir}/services/${api.module}.service.ts`,
        content: serviceSource(api, baseUrl, url),
      },
      ...operations.flatMap((op) => operationFiles(dir, op, api, baseUrl)),
    ],
    modify: [
      wired,
      wire(
        module,
        "Workflow",
        "providers",
        api.className,
        api.className,
        importPath(module.path, `${dir}/services/${api.module}.service.ts`),
      ),
    ],
  };
}
