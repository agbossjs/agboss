import { resolveTools, type AssembledWorkflow, type WorkflowServices } from "../workflow.js";
import { inputJsonSchema, type JsonSchema } from "../dto/schema.js";
import { NodeKind } from "../flow/ast.js";
import { dtoJsonSchemaOf, dtoSchemaHashOf } from "../flow/runtime/join-keys.js";
import { configSnapshot } from "../run/versions.js";
import { versionOf } from "../terns/index.js";
import type { AnyTool } from "../tools/index.js";
import {
  edgesOf,
  errorHandlersOf,
  launchesOfGraph,
  type EdgeSnapshot,
  type ErrorHandlerSnapshot,
  type LaunchSnapshot,
} from "./snapshot-flow.js";
import { nodesOf, type NodeSnapshot } from "./snapshot-nodes.js";

/**
 * The declarative snapshot of one workflow (#268 S92 / S93): what `agboss describe --json` gives per
 * workflow so that traces and records join the static schema — its `configHash` (the one key, as in
 * `WorkflowRecord` and every execution event), its starts and finishes, nodes with their internals
 * and join keys, edges, the `.onError` table, launches, and the JSON Schema of every DTO on its paths
 * and every tool's input and output, each with its `schemaHash`. Read from the assembly: no model
 * call, no project code but the tools' construction.
 */

/** One DTO's schema: its hash and its JSON Schema. */
export interface DtoSchemaSnapshot {
  readonly schemaHash: string;
  readonly jsonSchema: JsonSchema;
}

/** One tool's schemas: the hash of both and each JSON Schema. */
export interface ToolSchemaSnapshot {
  readonly promptHash: string;
  readonly schemaHash: string;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
}

/** The schemas of a workflow, by DTO class and by tool name. */
export interface SchemasSnapshot {
  readonly dtos: Readonly<Record<string, DtoSchemaSnapshot>>;
  readonly tools: Readonly<Record<string, ToolSchemaSnapshot>>;
}

/** One workflow's declarative snapshot. */
export interface WorkflowSnapshot {
  readonly configHash: string;
  readonly starts: readonly string[];
  readonly finishes: readonly string[];
  readonly nodes: readonly NodeSnapshot[];
  readonly edges: readonly EdgeSnapshot[];
  readonly onError: readonly ErrorHandlerSnapshot[];
  readonly launches: readonly LaunchSnapshot[];
  readonly schemas: SchemasSnapshot;
}

const toolSchemaOf = (tool: AnyTool): ToolSchemaSnapshot => {
  const input = inputJsonSchema(tool.input);
  const output = inputJsonSchema(tool.output);
  return {
    promptHash: versionOf(tool.description),
    schemaHash: versionOf({ input, output }),
    input,
    output,
  };
};

function schemasOf(bundle: AssembledWorkflow, tools: readonly AnyTool[]): SchemasSnapshot {
  const dtos = [...bundle.graph.dtos.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, dto]): [string, DtoSchemaSnapshot] => [
      name,
      { schemaHash: dtoSchemaHashOf(dto), jsonSchema: dtoJsonSchemaOf(dto) },
    ]);
  const byTool = tools.map((tool): [string, ToolSchemaSnapshot] => [tool.name, toolSchemaOf(tool)]);
  return { dtos: Object.fromEntries(dtos), tools: Object.fromEntries(byTool) };
}

const namesOfKind = (bundle: AssembledWorkflow, kind: NodeKind): readonly string[] =>
  [...bundle.graph.nodes.values()].filter((node) => node.kind === kind).map((node) => node.id);

/** The snapshot of one assembled workflow, its tools built with `services`. */
export function workflowSnapshotOf(
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): WorkflowSnapshot {
  return {
    configHash: versionOf(configSnapshot(bundle)),
    starts: namesOfKind(bundle, NodeKind.Start),
    finishes: namesOfKind(bundle, NodeKind.Finish),
    nodes: nodesOf(bundle),
    edges: edgesOf(bundle.graph),
    onError: errorHandlersOf(bundle.graph),
    launches: launchesOfGraph(bundle.graph),
    schemas: schemasOf(bundle, resolveTools(bundle, services)),
  };
}
