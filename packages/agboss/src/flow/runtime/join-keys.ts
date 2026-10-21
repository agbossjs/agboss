import { z } from "zod";
import { schemaOf, type JsonSchema } from "../../dto/schema.js";
import type { DtoClass } from "../../dto/types.js";
import { promptTextOf } from "../../components/prompt-render.js";
import { versionOf } from "../../terns/index.js";
import { NodeKind } from "../ast.js";
import type { ComponentDeclaration, InputFieldShape } from "../decorators/declaration.js";
import { isWrapper, Wrapper, type AnyWrapper, type OutputShape } from "../dto-wrappers.js";
import type { RuntimeGraph, RuntimeNode } from "./graph-model.js";
import { ComponentKind, type ComponentRecord } from "./records.js";
import type { LoadedRouter } from "./routers.js";

/**
 * The join keys of a workflow's components (#268 S92 / S93): one `ComponentRecord` per node — its
 * kind, the hash of what its model is told (`promptHash`) and of what it reads and writes
 * (`schemaHash`) — the same in `agboss describe --json`, in the execution's events and records, so
 * a trace joins the declarative snapshot. A DTO enters a hash by its JSON Schema's hash: a field
 * renamed or retyped changes every component that reads or writes it.
 */

/** The kind of each node's component. */
const KIND_OF_NODE: Readonly<Record<NodeKind, ComponentKind>> = {
  [NodeKind.Start]: ComponentKind.WorkflowStart,
  [NodeKind.Finish]: ComponentKind.WorkflowFinish,
  [NodeKind.Agent]: ComponentKind.Agent,
  [NodeKind.Action]: ComponentKind.Action,
  [NodeKind.Router]: ComponentKind.Router,
  [NodeKind.Workflow]: ComponentKind.Workflow,
};

/** The component kind of a node kind. */
export const componentKindOf = (kind: NodeKind): ComponentKind => KIND_OF_NODE[kind];

/** The JSON Schema of a DTO as `describe --json` gives it: what is sent and accepted, no `$schema`. */
export function dtoJsonSchemaOf(dto: DtoClass): JsonSchema {
  const json = z.toJSONSchema(schemaOf(dto), { io: "input", unrepresentable: "any" });
  delete json.$schema;
  return json;
}

const dtoHashes = new WeakMap<DtoClass, string>();

/** The hash of a DTO's JSON Schema (`schemas.dtos.<class>.schemaHash`). */
export function dtoSchemaHashOf(dto: DtoClass): string {
  const known = dtoHashes.get(dto);
  if (known !== undefined) return known;
  const hash = versionOf(dtoJsonSchemaOf(dto));
  dtoHashes.set(dto, hash);
  return hash;
}

/** A shape on a path as hashed and described: each DTO by its class name and schema hash. */
export type DescribedShape =
  | { readonly dto: string; readonly schemaHash: string }
  | { readonly listOf: DescribedShape }
  | { readonly oneOf: readonly DescribedShape[] }
  | { readonly optional: DescribedShape }
  | { readonly historyOf: DescribedShape; readonly limit?: number }
  | { readonly fields: Readonly<Record<string, DescribedShape>> };

/** Anything a component reads or writes: a DTO, a wrapper of DTOs, or a map of fields. */
export type ComponentShape = DtoClass | AnyWrapper | Readonly<Record<string, InputFieldShape>>;

function wrapperShape(wrapper: AnyWrapper): DescribedShape {
  switch (wrapper.kind) {
    case Wrapper.List:
      return { listOf: describedShapeOf(wrapper.element) };
    case Wrapper.OneOf:
      return { oneOf: wrapper.variants.map(describedShapeOf) };
    case Wrapper.Optional:
      return { optional: describedShapeOf(wrapper.inner) };
    case Wrapper.History:
      return wrapper.limit === undefined
        ? { historyOf: describedShapeOf(wrapper.dto) }
        : { historyOf: describedShapeOf(wrapper.dto), limit: wrapper.limit };
  }
}

/** A shape described: `{ dto, schemaHash }`, `{ listOf }`, `{ oneOf }`, … or `{ fields }`. */
export function describedShapeOf(shape: ComponentShape): DescribedShape {
  if (typeof shape === "function") return { dto: shape.name, schemaHash: dtoSchemaHashOf(shape) };
  if (isWrapper(shape)) return wrapperShape(shape);
  const fields = Object.entries(shape).map(([field, value]): [string, DescribedShape] => [
    field,
    describedShapeOf(value),
  ]);
  return { fields: Object.fromEntries(fields) };
}

/** What a component reads (`input`) and writes (`output`), as its decorator says. */
export interface ComponentIo {
  readonly input?: ComponentShape;
  readonly output?: OutputShape;
}

/** A node's `input` and `output` from its declaration; a child workflow's node declares none. */
export function componentIoOf(declaration: ComponentDeclaration): ComponentIo {
  switch (declaration.kind) {
    case NodeKind.Start:
    case NodeKind.Router:
      return { input: declaration.options.input };
    case NodeKind.Finish:
    case NodeKind.Agent:
    case NodeKind.Action: {
      const { input, output } = declaration.options;
      return {
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
      };
    }
    case NodeKind.Workflow:
      return {};
  }
}

/** What a component reads and writes, described. */
export interface DescribedIo {
  readonly input?: DescribedShape;
  readonly output?: DescribedShape;
}

/** The described `input` / `output` of a component; empty when it declares neither. */
export function describedIoOf(io: ComponentIo): DescribedIo {
  return {
    ...(io.input === undefined ? {} : { input: describedShapeOf(io.input) }),
    ...(io.output === undefined ? {} : { output: describedShapeOf(io.output) }),
  };
}

/** The hash of a component's described `input` / `output`; `undefined` when it has neither. */
export function schemaHashOfIo(io: ComponentIo): string | undefined {
  const described = describedIoOf(io);
  return Object.keys(described).length === 0 ? undefined : versionOf(described);
}

/** What the components' hashes are made from: the graph and the texts its models are sent. */
export interface JoinKeySource {
  readonly graph: RuntimeGraph;
  /** Each agent's instructions, by its name. */
  readonly prompts: Readonly<Record<string, unknown>>;
  /** Every model router with its texts loaded. */
  readonly routers: readonly LoadedRouter[];
}

/** A model router's texts: its instructions and each route's condition, by target. */
export const routerPromptOf = (router: LoadedRouter): object => ({
  instructions: router.instructions,
  routes: router.routes.map(({ option, condition }) => ({ option, condition })),
});

function promptHashOfNode(node: RuntimeNode, source: JoinKeySource): string | undefined {
  if (node.kind === NodeKind.Agent)
    return versionOf(promptTextOf(Reflect.get(source.prompts, node.id)) ?? "");
  if (node.kind !== NodeKind.Router) return undefined;
  const router = source.routers.find((loaded) => loaded.name === node.id);
  return router === undefined ? undefined : versionOf(routerPromptOf(router));
}

/** One node's record: its name, kind and hashes. */
export const nodeRecordOf = (node: RuntimeNode, source: JoinKeySource): ComponentRecord => ({
  name: node.id,
  kind: componentKindOf(node.kind),
  promptHash: promptHashOfNode(node, source),
  schemaHash: schemaHashOfIo(componentIoOf(node.declaration)),
});

/** Every node's record of a workflow, by its `name`. */
export const componentRecordsOf = (source: JoinKeySource): ReadonlyMap<string, ComponentRecord> =>
  new Map([...source.graph.nodes.values()].map((node) => [node.id, nodeRecordOf(node, source)]));
