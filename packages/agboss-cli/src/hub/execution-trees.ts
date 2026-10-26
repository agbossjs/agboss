import type { ChildExecutionRecord, ExecutionHistoryRecord, ToolCallRecord } from "@agboss/core";
import type { HubRecord } from "./hub-inputs.js";

/**
 * Cross-Service Execution Trees (#401 PR 4): one execution tree across applications, stitched from
 * their exports by the report's rule — a record with `origin` is a child of the execution whose
 * `executionId` is `origin.executionId` (a root's, or one of its children's), under that
 * execution's tool call whose step `idempotencyKey` is `origin.step.idempotencyKey`. Never by
 * tenant (#398 Q3: absent across organisations). A caller's call with `remote` whose receiver did
 * not export its record is a stub, not an error.
 */

/** A remote execution no input holds: the caller saw it, the receiver did not export it. */
export interface TreeStub {
  readonly kind: "stub";
  readonly application: string;
  readonly executionId: string;
}

/** One tool call of an execution that ran a remote execution. */
export interface TreeCall {
  readonly tool: string;
  readonly key: string;
  readonly status: string;
  readonly target: TreeExecution | TreeStub;
}

/** One execution of a tree: a root of an application, or one of its in-process children. */
export interface TreeExecution {
  readonly kind: "execution";
  readonly application: string;
  readonly executionId: string;
  readonly workflow: string;
  readonly status: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly spendUsd: number;
  /** The export it came from; a child's is its root's. */
  readonly file: string;
  readonly calls: readonly TreeCall[];
  /** Its in-process child executions (#263) that made remote calls. */
  readonly children: readonly TreeExecution[];
}

/** A tree that crosses applications, from its root. */
export interface ExecutionTree {
  readonly root: TreeExecution;
  /** Every application it reaches, the root's first. */
  readonly applications: readonly string[];
  readonly executions: number;
  /** Remote executions it called that no input holds. */
  readonly stubs: number;
  /** Who called the root, when its caller did not export its record. */
  readonly calledBy?: { readonly application: string; readonly executionId: string };
}

/** What made calls: a root's record or a child's. */
interface Execution {
  readonly executionId: string;
  readonly workflow: { readonly name: string };
  readonly status: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly spend: { readonly totalUsd: number };
  readonly toolCalls: readonly ToolCallRecord[];
  readonly children: readonly ChildExecutionRecord[];
}

/** The records a tree is stitched from: by the receiver's origin key, by every execution id. */
interface Index {
  /** The receiving root of each calling step's key. */
  readonly byOriginKey: ReadonlyMap<string, HubRecord>;
  /** The root record holding each execution id (a root's own and its children's). */
  readonly holderOf: ReadonlyMap<string, HubRecord>;
}

const childIds = (children: readonly ChildExecutionRecord[]): string[] =>
  children.flatMap((child) => [child.executionId, ...childIds(child.children)]);

function indexOf(records: readonly HubRecord[]): Index {
  const byOriginKey = new Map<string, HubRecord>();
  const holderOf = new Map<string, HubRecord>();
  for (const hub of records) {
    const { record } = hub;
    if (record.origin !== undefined) byOriginKey.set(record.origin.step.idempotencyKey, hub);
    for (const id of [record.executionId, ...childIds(record.children)]) holderOf.set(id, hub);
  }
  return { byOriginKey, holderOf };
}

/** Stitching from a root: the visited records, so a malformed input cannot loop. */
interface Walk {
  readonly index: Index;
  readonly visited: Set<HubRecord>;
}

function callOf(walk: Walk, call: ToolCallRecord): TreeCall | undefined {
  if (call.remote === undefined) return undefined;
  const key = call.step.idempotencyKey;
  const receiver = walk.index.byOriginKey.get(key);
  const target =
    receiver === undefined || walk.visited.has(receiver)
      ? ({ kind: "stub", ...call.remote } satisfies TreeStub)
      : rootOf(walk, receiver);
  return { tool: call.step.component.name, key, status: call.status, target };
}

/** Whether an execution, or one below it, calls another application. */
const callsOut = (execution: TreeExecution): boolean =>
  execution.calls.length > 0 || execution.children.length > 0;

function executionOf(walk: Walk, hub: HubRecord, execution: Execution): TreeExecution {
  const calls = execution.toolCalls.flatMap((call) => callOf(walk, call) ?? []);
  const children = execution.children
    .map((child) => executionOf(walk, hub, child))
    .filter(callsOut);
  return {
    kind: "execution",
    application: hub.record.application.name,
    executionId: execution.executionId,
    workflow: execution.workflow.name,
    status: execution.status,
    ...(execution.startedAt === undefined ? {} : { startedAt: execution.startedAt }),
    ...(execution.endedAt === undefined ? {} : { endedAt: execution.endedAt }),
    spendUsd: execution.spend.totalUsd,
    file: hub.file,
    calls,
    children,
  };
}

function rootOf(walk: Walk, hub: HubRecord): TreeExecution {
  walk.visited.add(hub);
  return executionOf(walk, hub, hub.record);
}

/** Every execution of a tree, depth first, and the stubs it reaches. */
function partsOf(execution: TreeExecution): { executions: TreeExecution[]; stubs: TreeStub[] } {
  const below = [
    ...execution.children,
    ...execution.calls.flatMap((call) => (call.target.kind === "execution" ? [call.target] : [])),
  ].map(partsOf);
  const stubs = execution.calls.flatMap((call) =>
    call.target.kind === "stub" ? [call.target] : [],
  );
  return {
    executions: [execution, ...below.flatMap((part) => part.executions)],
    stubs: [...stubs, ...below.flatMap((part) => part.stubs)],
  };
}

/** Whether a record is called by an execution an input holds: then it is not a root. */
const isCalledFromInputs = (record: ExecutionHistoryRecord, index: Index): boolean =>
  record.origin !== undefined && index.holderOf.has(record.origin.executionId);

function treeOf(walk: Walk, hub: HubRecord): ExecutionTree {
  const root = rootOf(walk, hub);
  const { executions, stubs } = partsOf(root);
  const applications = [
    ...new Set([
      ...executions.map((each) => each.application),
      ...stubs.map((stub) => stub.application),
    ]),
  ];
  const { origin } = hub.record;
  return {
    root,
    applications,
    executions: executions.length,
    stubs: stubs.length,
    ...(origin === undefined
      ? {}
      : { calledBy: { application: origin.application, executionId: origin.executionId } }),
  };
}

/** The trees that cross applications, oldest root first; a tree within one application is left out. */
export function executionTreesOf(records: readonly HubRecord[]): ExecutionTree[] {
  const index = indexOf(records);
  const walk: Walk = { index, visited: new Set() };
  const byStart = [...records].sort((left, right) =>
    left.record.startedAt.localeCompare(right.record.startedAt),
  );
  const trees = byStart
    .filter(({ record }) => !isCalledFromInputs(record, index))
    .map((hub) => treeOf(walk, hub));
  // a receiver its caller's record holds no call to (no `remote` on it): a root of its own
  const orphans = byStart.filter((hub) => !walk.visited.has(hub)).map((hub) => treeOf(walk, hub));
  return [...trees, ...orphans].filter(
    (tree) => tree.applications.length > 1 || tree.calledBy !== undefined,
  );
}

/** The tree of one root execution, or undefined (`hub ui`'s `GET /api/trees/:rootExecutionId`). */
export function executionTreeOf(
  trees: readonly ExecutionTree[],
  rootExecutionId: string,
): ExecutionTree | undefined {
  return trees.find((tree) => tree.root.executionId === rootExecutionId);
}
