import type { Class } from "../../components/injection.js";
import type { GraphDeps } from "../../graph/deps.js";
import type { WorkflowIdentity } from "./step-frame.js";
import { configSnapshot } from "../../run/versions.js";
import { versionOf } from "../../terns/index.js";
import type { ErrorRecord } from "../../core/error-record.js";
import { NodeKind } from "../ast.js";
import type { HandledErrorRecord } from "./child-records.js";
import type { RuntimeGraph } from "./graph-model.js";
import { componentKindOf, componentRecordsOf } from "./join-keys.js";
import { bareRecordOf } from "./records.js";
import type { ComponentKind, ComponentRecord } from "./records.js";

/**
 * The join keys of one workflow at run time (#268 S93): its `configHash` — the one key of the
 * workflow, the same as its records' and `agboss describe --json`'s — and every component's record.
 * Made once per run dependencies.
 */
export interface WorkflowJoinKeys {
  readonly configHash: string;
  readonly components: ReadonlyMap<string, ComponentRecord>;
}

/** Made once per config and graph: a pass's copy of the run dependencies (a lease's) shares them. */
const made = new WeakMap<object, WeakMap<RuntimeGraph, WorkflowJoinKeys>>();

/** The workflow's join keys, made on first use. */
export function joinKeysOf(deps: GraphDeps<string>): WorkflowJoinKeys {
  const byGraph = made.get(deps.config) ?? new WeakMap<RuntimeGraph, WorkflowJoinKeys>();
  made.set(deps.config, byGraph);
  const known = byGraph.get(deps.graph);
  if (known !== undefined) return known;
  const keys = {
    configHash: versionOf(configSnapshot(deps)),
    components: componentRecordsOf(deps),
  };
  byGraph.set(deps.graph, keys);
  return keys;
}

/** The record of a component of the workflow by its `name`; one it does not know has no hashes. */
export const recordOfComponent = (
  components: ReadonlyMap<string, ComponentRecord>,
  name: string,
  kind: ComponentKind,
): ComponentRecord => components.get(name) ?? bareRecordOf(name, kind);

/** The records a graph's steps name: its components', each node's kind for one it does not list. */
export interface ComponentRecords {
  readonly components: ReadonlyMap<string, ComponentRecord>;
  readonly graph: Pick<RuntimeGraph, "nodes">;
}

/** The record of one node of the graph by its `name`. */
export function recordOfNode(
  { components, graph }: ComponentRecords,
  name: string,
): ComponentRecord {
  const kind = graph.nodes.get(name)?.kind ?? NodeKind.Workflow;
  return recordOfComponent(components, name, componentKindOf(kind));
}

/** A failure a side path took: the node that failed and the first node of the side path. */
export const handledErrorOf = (
  records: ComponentRecords,
  error: ErrorRecord,
  at: string,
  by: string,
): HandledErrorRecord => ({ error, at: recordOfNode(records, at), by: recordOfNode(records, by) });

/** The workflow a graph runs as its steps' `ExecutionContext` names it: with its `configHash`. */
export const workflowIdentityOf = (
  deps: GraphDeps<string>,
  type: Class = deps.graph.type,
): WorkflowIdentity => ({
  type,
  name: deps.config.name,
  version: deps.config.version,
  configHash: joinKeysOf(deps).configHash,
});

/** The record of one node of a workflow by its `name`, from its run dependencies. */
export const nodeRecordIn = (deps: GraphDeps<string>, name: string): ComponentRecord =>
  recordOfNode({ components: joinKeysOf(deps).components, graph: deps.graph }, name);
