import type { ComponentOptions } from "../components/component-options.js";
import { cardFileFieldsOf } from "../a2a/files/a2a-file-options.js";
import { A2AReply } from "../a2a/a2a-message-skill-rule.js";
import {
  cardFileFieldsSourceOf,
  skillOptionsOf,
  startsOfEndpoint,
} from "../a2a/a2a-endpoint.decorator.js";
import type { AssembledApplication } from "../application/assemble.js";
import type { A2AAgentMeta } from "../a2a/a2a-decorator.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import type { DtoClass } from "../dto/types.js";
import { NodeKind } from "../flow/ast.js";
import { mcpServerClassesOf } from "../components/assemble-tools.js";
import type { ProviderModule } from "../components/container/registrations.js";
import { usesOf, workflowPartsOf, type WorkflowParts } from "./contracts-parts.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { dtoJsonSchemaOf, dtoSchemaHashOf } from "../flow/runtime/join-keys.js";
import type {
  A2AExportContract,
  A2AForeignImportContract,
  A2AImportBase,
  A2AImportContract,
  ContractDto,
  ContractsSnapshot,
  McpExportContract,
  McpImportContract,
} from "./contracts-types.js";

export type * from "./contracts-types.js";

/**
 * The application's declared contracts (#398 PR 3), as `agboss describe --json` lists them under
 * `application.contracts`: what it **exports** — each `@A2AEndpoint` start (its input and its
 * finishes' outputs) and each `@McpEndpoint` tool listed in `@Application({ endpoints })` — and what
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
  if (meta?.kind !== "a2a-endpoint") return [];
  return startsOfEndpoint(meta.meta).flatMap((start): A2AExportContract[] => {
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
        skill: declaration.options.name,
        workflow: workflow.name,
        input: dtos.ofShape(declaration.options.input),
        outputs,
        reply: skillOptionsOf(meta.meta, declaration.options.name)?.reply ?? A2AReply.Task,
        cardFileFields: cardFileFieldsOf(
          cardFileFieldsSourceOf(meta.meta),
          declaration.options.name,
        ),
      },
    ];
  });
}

function mcpExportsOf(expose: Class, dtos: Dtos): readonly McpExportContract[] {
  const meta = componentOf(expose);
  if (meta?.kind !== "mcp-endpoint") return [];
  return meta.meta.tools.flatMap((exported): McpExportContract[] => {
    const start = declarationOf(exported);
    const tool = componentOf(exported);
    const base = { kind: "mcp" as const, expose: meta.meta.name, version: meta.meta.version };
    if (start?.kind === NodeKind.Start)
      return [{ ...base, tool: start.options.name, input: dtos.ofShape(start.options.input) }];
    if (tool?.kind === "tool")
      return [{ ...base, tool: tool.meta.name, input: dtos.of(tool.meta.input) }];
    return [];
  });
}

type A2AImport = A2AImportContract | A2AForeignImportContract;

/** The foreign import (#812): a peer that is no AGBoss application, listed typed or not. */
function foreignImportOf(base: A2AImportBase, meta: A2AAgentMeta, dtos: Dtos): A2AImport {
  const { input, output } = meta;
  return {
    ...base,
    foreign: true,
    target: null,
    input: input === undefined ? null : dtos.of(input),
    output: output === undefined ? null : dtos.of(output),
  };
}

/** The import of one `@A2AAgent`; none for an untyped agent of an AGBoss application (#809). */
function a2aImportOf(
  client: Class,
  parts: readonly WorkflowParts[],
  dtos: Dtos,
  options: ComponentOptions,
): A2AImport[] {
  // the agent as the profiles leave it: its price is what the snapshot says
  const meta = options.a2aAgentMetaOf(client);
  if (meta === undefined) return [];
  const { name, target, input, output, costPerCall } = meta;
  const base = {
    kind: "a2a" as const,
    client: name,
    usedBy: usesOf(client, parts),
    price: costPerCall ?? null,
  };
  if (target?.application === undefined) return [foreignImportOf(base, meta, dtos)];
  if (input === undefined || output === undefined) return [];
  return [
    {
      ...base,
      foreign: false,
      target: {
        application: target.application,
        skill: target.skill ?? "",
        // #916: present only when the client takes some of the skill's finishes
        ...(target.finishes === undefined ? {} : { finishes: [...target.finishes] }),
      },
      input: dtos.of(input),
      output: dtos.of(output),
    },
  ];
}

function a2aImportsOf(
  assembled: AssembledApplication,
  parts: readonly WorkflowParts[],
  dtos: Dtos,
): readonly A2AImport[] {
  const providers = assembled.modules.flatMap((module) => module.providers);
  const clients = [...new Set(providers)].filter(
    (provider): provider is Class =>
      typeof provider === "function" && componentOf(provider)?.kind === "a2a-agent",
  );
  return clients.flatMap((client) => a2aImportOf(client, parts, dtos, assembled.componentOptions));
}

function mcpImportsOf(
  parts: readonly WorkflowParts[],
  modules: readonly ProviderModule[],
  dtos: Dtos,
): readonly McpImportContract[] {
  const tools = parts.flatMap((part) => part.tools);
  const servers = mcpServerClassesOf(tools, modules);
  return servers.flatMap((server): McpImportContract[] => {
    const meta = componentOf(server);
    if (meta?.kind !== "mcp-server") return [];
    const declared = meta.meta.config.target;
    const target =
      declared === undefined
        ? null
        : { application: declared.application, expose: declared.endpoint };
    return Object.entries(meta.meta.tools).map(([tool, io]) => ({
      kind: "mcp",
      server: meta.meta.name,
      tool,
      target,
      usedBy: usesOf(server, parts),
      input: io.input === undefined ? null : dtos.of(io.input),
      output: dtos.of(io.output),
    }));
  });
}

/** The declared contracts of an assembled application. */
export function contractsOf(assembled: AssembledApplication): ContractsSnapshot {
  const dtos = new Dtos();
  const parts = workflowPartsOf(assembled.workflows.map((bundle) => bundle.graph.type));
  const exports = assembled.endpoints.flatMap((expose) => [
    ...a2aExportsOf(expose, parts, dtos),
    ...mcpExportsOf(expose, dtos),
  ]);
  const imports = [
    ...a2aImportsOf(assembled, parts, dtos),
    ...mcpImportsOf(parts, assembled.modules, dtos),
  ];
  return { exports, imports, schemas: dtos.schemas() };
}
