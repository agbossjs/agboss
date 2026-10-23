import type { AssembledApplication } from "../application/assemble.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import type { DtoClass } from "../dto/types.js";
import { NodeKind } from "../flow/ast.js";
import { mcpUsesOf, usesOf, workflowPartsOf, type WorkflowParts } from "./contracts-parts.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { dtoJsonSchemaOf, dtoSchemaHashOf } from "../flow/runtime/join-keys.js";
import type {
  A2AExportContract,
  A2AImportContract,
  ContractDto,
  ContractsSnapshot,
  McpExportContract,
  McpImportContract,
} from "./contracts-types.js";

export type * from "./contracts-types.js";

/**
 * The application's declared contracts (#398 PR 3), as `agboss describe --json` lists them under
 * `application.contracts`: what it **exports** — each `@A2AExpose` start (its input and its
 * finishes' outputs) and each `@McpExpose` tool listed in `@Application({ exposes })` — and what
 * it **consumes** — each `@A2AAgent` (its target, input, output, price and the tools that use it)
 * and each `@McpServer` tool (its target, or `null` for a third-party server). Every DTO is named
 * with its `schemaHash`; `schemas` holds the JSON Schema of each, what `check --federation`
 * compares structurally. Read from the declarations: no model call, no project code.
 */

/** Collects the DTOs named, for `schemas`. */
class Dtos {
  readonly #byName = new Map<string, DtoClass>();

  of(dto: DtoClass): ContractDto {
    this.#byName.set(dto.name, dto);
    return { dto: dto.name, schemaHash: dtoSchemaHashOf(dto) };
  }

  /** A component's shape when it is one DTO class; `null` for a map of fields or a wrapper. */
  ofShape(shape: unknown): ContractDto | null {
    return typeof shape === "function" ? this.of(shape as DtoClass) : null;
  }

  schemas(): ContractsSnapshot["schemas"] {
    const sorted = [...this.#byName.entries()].sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(
      sorted.map(([name, dto]) => [
        name,
        { schemaHash: dtoSchemaHashOf(dto), jsonSchema: dtoJsonSchemaOf(dto) },
      ]),
    );
  }
}

const kindOf = (node: Class): NodeKind | undefined => declarationOf(node)?.kind;

function a2aExportsOf(
  expose: Class,
  parts: readonly WorkflowParts[],
  dtos: Dtos,
): readonly A2AExportContract[] {
  const meta = componentOf(expose);
  if (meta?.kind !== "a2a-expose") return [];
  return meta.meta.exports.flatMap((start): A2AExportContract[] => {
    const workflow = parts.find((part) => part.nodes.includes(start));
    const declaration = declarationOf(start);
    if (workflow === undefined || declaration?.kind !== NodeKind.Start) return [];
    const outputs = workflow.nodes
      .filter((node) => kindOf(node) === NodeKind.Finish)
      .flatMap((node) => {
        const finish = declarationOf(node);
        if (finish?.kind !== NodeKind.Finish) return [];
        const output = dtos.ofShape(finish.options.output);
        return output === null ? [] : [{ finish: finish.options.name, ...output }];
      });
    return [
      {
        kind: "a2a",
        expose: meta.meta.name,
        version: meta.meta.version,
        start: declaration.options.name,
        workflow: workflow.name,
        input: dtos.ofShape(declaration.options.input),
        outputs,
      },
    ];
  });
}

function mcpExportsOf(expose: Class, dtos: Dtos): readonly McpExportContract[] {
  const meta = componentOf(expose);
  if (meta?.kind !== "mcp-expose") return [];
  return meta.meta.exports.flatMap((exported): McpExportContract[] => {
    const start = declarationOf(exported);
    const tool = componentOf(exported);
    const base = { kind: "mcp" as const, expose: meta.meta.name, version: meta.meta.version };
    if (start?.kind === NodeKind.Start)
      return [{ ...base, tool: start.options.name, input: dtos.ofShape(start.options.input) }];
    if (tool?.kind === "tool" || tool?.kind === "mcp-tool")
      return [{ ...base, tool: tool.meta.name, input: dtos.of(tool.meta.input) }];
    return [];
  });
}

function a2aImportsOf(
  assembled: AssembledApplication,
  parts: readonly WorkflowParts[],
  dtos: Dtos,
): readonly A2AImportContract[] {
  const providers = assembled.modules.flatMap((module) => module.providers);
  const clients = [...new Set(providers)].filter(
    (provider): provider is Class =>
      typeof provider === "function" && componentOf(provider)?.kind === "a2a-agent",
  );
  return clients.flatMap((client): A2AImportContract[] => {
    const meta = componentOf(client);
    if (meta?.kind !== "a2a-agent") return [];
    const { name, target, input, output, price } = meta.meta;
    return [
      {
        kind: "a2a",
        client: name,
        target: { application: target.application, start: target.start },
        usedBy: usesOf(client, parts),
        input: dtos.of(input),
        output: dtos.of(output),
        price: price ?? null,
      },
    ];
  });
}

function mcpImportsOf(parts: readonly WorkflowParts[], dtos: Dtos): readonly McpImportContract[] {
  const servers = new Set<Class>();
  for (const tool of parts.flatMap((part) => part.tools)) {
    const meta = componentOf(tool);
    if (meta?.kind === "mcp-tool") servers.add(meta.meta.server);
  }
  return [...servers].flatMap((server): McpImportContract[] => {
    const meta = componentOf(server);
    if (meta?.kind !== "mcp-server") return [];
    const target = meta.meta.config.target ?? null;
    return Object.entries(meta.meta.tools).map(([tool, io]) => ({
      kind: "mcp",
      server: meta.meta.name,
      tool,
      target,
      usedBy: mcpUsesOf(server, parts),
      input: dtos.of(io.input),
      output: dtos.of(io.output),
    }));
  });
}

/** The declared contracts of an assembled application. */
export function contractsOf(assembled: AssembledApplication): ContractsSnapshot {
  const dtos = new Dtos();
  const parts = workflowPartsOf(assembled.workflows.map((bundle) => bundle.graph.type));
  const exports = assembled.exposes.flatMap((expose) => [
    ...a2aExportsOf(expose, parts, dtos),
    ...mcpExportsOf(expose, dtos),
  ]);
  const imports = [...a2aImportsOf(assembled, parts, dtos), ...mcpImportsOf(parts, dtos)];
  return { exports, imports, schemas: dtos.schemas() };
}
