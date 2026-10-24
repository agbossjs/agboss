import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { Class } from "../../../components/injection.js";
import type { ExecutionFacts, ParentExecution } from "../../context/frame.js";
import type { StepRecord, WorkflowRecord } from "../../context/execution-context.js";
import type { TenantContext } from "../../context/tenant-context.js";
import type { ContextFields } from "../../context/context-values.js";
import type { ExecutionStateType } from "../state.js";
import type { ChildIdentityRecord } from "../child-records.js";

/** A child's first state (what its parent's node starts it with), as plain values. */
export type ChildInitialState = Pick<
  ExecutionStateType,
  | "runId"
  | "start"
  | "startInput"
  | "contexts"
  | "usage"
  | "budgets"
  | "budgetUsd"
  | "piiTokens"
  | "piiKey"
> & { readonly child: ChildIdentityRecord };

/**
 * What a worker runs a queued child with (#333 PR 2): the child's first state, its own thread, the
 * conversation it belongs to, and its parents as plain data — the classes of their workflows and
 * steps are looked up again on the worker, its signal and tenant are the worker's own. Written with
 * the checkpointer's serializer (the same encoding as the child's checkpoints), kept as JSON text
 * in the queue row.
 */

/** A parent execution as plain data: its record, its launching step, and its own parent. */
export interface ParentRecord {
  readonly executionId: string;
  readonly threadId: string;
  readonly ownerId?: string | undefined;
  readonly workflow: WorkflowRecord;
  readonly itemIndex?: number | undefined;
  /** The step of this execution that launched the execution below it. */
  readonly step: StepRecord;
  readonly parent?: ParentRecord | undefined;
}

/** A queued child's run. */
export interface RemoteChildRun {
  /** Its own checkpoint thread (`<parentThread>/child/<id>`). */
  readonly thread: string;
  /** The conversation thread the tree belongs to (`executionContext.threadId`). */
  readonly threadId: string;
  readonly ownerId?: string | undefined;
  /** Its start's validated input (`run.input`). */
  readonly input: Readonly<Record<string, unknown>>;
  /** Its first state, as its parent's node made it. */
  readonly initial: ChildInitialState;
  /** Its parent and the step that launched it. */
  readonly parent: ParentRecord;
  /** The child's own resume map when a paused child is continued (`app.resume`, #333 PR 4). */
  readonly resume?: Readonly<Record<string, string>> | undefined;
}

/** The checkpointer's serializer: what the child's checkpoints are written with. */
type SerializerProtocol = BaseCheckpointSaver["serde"];

/** A parent's facts as plain data, up to the root. */
export function parentRecordOf(parent: ParentExecution): ParentRecord {
  const { execution, step } = parent;
  const { name, version, startedVersion, configHash } = execution.workflow;
  const workflow = { name, version, startedVersion, configHash };
  const { kind, promptHash, schemaHash } = step.component;
  const component = { name: step.component.name, kind, promptHash, schemaHash };
  return {
    executionId: execution.executionId,
    threadId: execution.threadId,
    ownerId: execution.ownerId,
    workflow,
    itemIndex: execution.itemIndex,
    step: { ...step, component },
    parent: execution.parent === undefined ? undefined : parentRecordOf(execution.parent),
  };
}

/** What a worker restores a parent with: the classes by name, its tenant, values and signal. */
export interface ParentRestore {
  /** The `@Workflow` class of a workflow name. */
  readonly workflowOf: (name: string) => Class | undefined;
  /** The class of a step's node in a workflow (`critic-agent#2` → `critic-agent`). */
  readonly componentOf: (workflow: string, nodeId: string) => Class | undefined;
  readonly tenant: TenantContext;
  readonly values: ContextFields;
  readonly signal: AbortSignal;
}

class UnknownParentClassError extends Error {
  override name = "UnknownParentClassError";
}

/** A parent's facts back from its record, on the worker. */
export function parentOfRecord(record: ParentRecord, restore: ParentRestore): ParentExecution {
  const type = restore.workflowOf(record.workflow.name);
  const component = restore.componentOf(record.workflow.name, record.step.nodeId);
  if (type === undefined || component === undefined)
    throw new UnknownParentClassError(
      `${record.workflow.name} (${record.step.nodeId}) is not a workflow of this application`,
    );
  const execution: ExecutionFacts = Object.freeze({
    executionId: record.executionId,
    threadId: record.threadId,
    ownerId: record.ownerId,
    signal: restore.signal,
    workflow: Object.freeze({ ...record.workflow, type }),
    tenant: restore.tenant,
    values: restore.values,
    ...(record.itemIndex === undefined ? {} : { itemIndex: record.itemIndex }),
    ...(record.parent === undefined ? {} : { parent: parentOfRecord(record.parent, restore) }),
  });
  const step = Object.freeze({
    ...record.step,
    component: Object.freeze({ ...record.step.component, type: component }),
  });
  return { execution, step };
}

/** The bytes as text: base64. */
const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A run as the queue row's `run` text. */
export async function encodedRun(serde: SerializerProtocol, run: RemoteChildRun): Promise<string> {
  const [type, bytes] = await serde.dumpsTyped(run);
  return JSON.stringify({ type, data: textOf(bytes) });
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** A decoded run, checked at the store boundary (its parts are the framework's own data). */
function isRun(value: unknown): value is RemoteChildRun {
  return (
    isRecord(value) &&
    typeof value.thread === "string" &&
    typeof value.threadId === "string" &&
    isRecord(value.input) &&
    isRecord(value.initial) &&
    isRecord(value.parent)
  );
}

class UnreadableChildRunError extends Error {
  override name = "UnreadableChildRunError";
}

/** A queue row's `run` text back as the run. */
export async function decodedRun(serde: SerializerProtocol, text: string): Promise<RemoteChildRun> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed.type !== "string" || typeof parsed.data !== "string")
    throw new UnreadableChildRunError("a queued child's run is not readable");
  const run: unknown = await serde.loadsTyped(parsed.type, Buffer.from(parsed.data, "base64"));
  if (!isRun(run)) throw new UnreadableChildRunError("a queued child's run is not readable");
  return run;
}
