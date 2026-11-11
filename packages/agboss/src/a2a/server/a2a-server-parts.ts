import type { ServerCallContext } from "@a2a-js/sdk/server";
import type { ExecutionControl } from "../../app/execution-control.js";
import type { ExecutionOptions } from "../../app/types.js";
import { EXECUTION_LEASE } from "../../app/lease-fence.js";
import type { Class } from "../../components/injection.js";
import { keyTextRuleOf } from "../../core/errors.js";
import { DEFAULT_TENANT_ID } from "../../flow/context/tenant-context.js";
import {
  isTerminalA2ATaskState,
  type A2ATaskKey,
  type A2ATaskRecord,
  type A2ATaskRepository,
  type A2ATaskStatus,
} from "../../infrastructure/a2a-task.repository.js";
import { taskChanged } from "../tasks/task-changes.js";
import type { Clock, IdGenerator } from "../../infrastructure/clock.js";
import type { FrameworkLog, LogSubject } from "../../infrastructure/logger.js";
import type { Milliseconds } from "../../units/index.js";
import type { A2AApp, A2ACaller, A2AOperation } from "../a2a-caller.js";
import { repairedTask } from "../tasks/a2a-task-repair.js";
import type { LocalRuns } from "./a2a-local-runs.js";
import type { ServedSkill } from "./a2a-skills.js";
import type { AdmittedRequest } from "./a2a-admitted.js";
import type { A2ARequestMesh } from "./a2a-mesh-admission.js";
import type { MeshSettings } from "../../mesh/mesh-settings.js";
import { invalidParams, taskNotFound } from "./a2a-wire-errors.js";
import type { A2AFileRepository } from "../../infrastructure/a2a-file.repository.js";
import type { FileFetches } from "../files/a2a-file-fetches.js";
import type { FileTransport } from "../files/a2a-file-transport.js";
import type { A2ADirectMessageRepository } from "../../infrastructure/a2a-direct-message.repository.js";
import type { CostLedgerRepository } from "../../infrastructure/cost-ledger.repository.js";

/**
 * What every operation of the server works with (#808): the app, its task store, its trees by id,
 * its clock and ids, the skills served, this listener's runs, and the request's caller — put into
 * the SDK's call context by the HTTP binding once the resolver admitted it.
 */

export interface A2AServerParts {
  readonly app: A2AApp;
  readonly tasks: A2ATaskRepository;
  readonly control: ExecutionControl;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly skills: readonly ServedSkill[];
  readonly runs: LocalRuns;
  readonly log: FrameworkLog;
  /** Every task's execution deadline (`a2aHttpListener({ maxTaskDuration })`); none when unset. */
  readonly maxTaskDuration: Milliseconds | undefined;
  /**
   * The application's mesh settings (#810): its name and `maxMeshHops` (what refuses a chain), its
   * signing key (what signs a trusted task's run report).
   */
  readonly mesh: MeshSettings;
  /** Where the tasks' files are kept, and how one by `url` is fetched (#859). */
  readonly files: A2AServerFiles;
  /** The direct-reply skills' replies (#860), and what a lost attempt's Unknown cost is written to. */
  readonly direct: A2ADirectParts;
}

/** What the direct-reply skills (#860, `A2AReply.Message`) work with. */
export interface A2ADirectParts {
  readonly messages: A2ADirectMessageRepository;
  readonly ledger: CostLedgerRepository;
  /** The skill a message that names none runs (`@A2AExpose({ defaultSkill })`), if any. */
  readonly defaultSkill: ServedSkill | undefined;
}

/** A listener's files (#859): the store, the fetch of a file by `url` and its bound. */
export interface A2AServerFiles {
  /** The application's `A2AFileRepository`; the built-in default keeps none (inline). */
  readonly store: A2AFileRepository;
  /** A test's own transport; `undefined`: the built-in `node:https` one. */
  readonly transport: FileTransport | undefined;
  readonly timeout: Milliseconds;
  /** The fetches in flight (#904): a concurrent duplicate of a message joins its file's fetch. */
  readonly fetches: FileFetches;
}

/** The admitted caller of one request, and the request's own end (its connection closed). */
export interface A2ARequestCaller {
  /** What the resolver admitted it for: the operation and task, as the transport decoded them. */
  readonly admitted: AdmittedRequest;
  readonly caller: A2ACaller<Class>;
  readonly tenantId: string;
  readonly ownerId: string | undefined;
  /** Aborted when the request's connection closes: what waits for the task stops — never the task. */
  readonly signal: AbortSignal;
  /** The request's mesh (#810): its envelope as checked, its body hash, its trusted peer. */
  readonly mesh: A2ARequestMesh;
}

// Stryker disable next-line StringLiteral: the state's key — any text names it, written and read alike
const CALLER = "agboss.a2a.caller";

/**
 * The resolver's tenant and owner, checked as a key's text before any store reads or writes them
 * (#552, #589: `t\uD800` and `t\uD801` would be one key in UTF-8): `-32602` naming the rule, never
 * the id.
 */
function checkedCallerIds(caller: A2ARequestCaller): void {
  const ids = { tenantId: caller.tenantId, ownerId: caller.ownerId };
  for (const [field, value] of Object.entries(ids)) {
    const rule = value === undefined ? undefined : keyTextRuleOf(value);
    if (rule !== undefined)
      throw invalidParams("a2a.invalid-caller", `the caller's ${field} is not a valid id`, {
        field,
        rule,
      });
  }
}

/** What a caller runs with: its tenant, owner and execution values — `app.execute`'s options. */
export type CallerOptions = Pick<ExecutionOptions, "tenant" | "ownerId" | "execution">;

/**
 * The caller's values as execution options. The resolver's types tie them to the listener's start;
 * the app checks them against its contexts (`dto.invalid`), as every execution's.
 */
export const callerOptionsOf = (caller: A2ARequestCaller): CallerOptions => caller.caller;

/** The call context's state holding an admitted caller. */
export function callerState(
  caller: A2ACaller<Class>,
  signal: AbortSignal,
  admitted: AdmittedRequest,
  mesh: A2ARequestMesh,
): Map<string, unknown> {
  const tenantId = caller.tenant?.tenantId ?? DEFAULT_TENANT_ID;
  const ownerId = caller.ownerId;
  const request: A2ARequestCaller = { caller, tenantId, ownerId, signal, admitted, mesh };
  return new Map<string, unknown>([[CALLER, request]]);
}

/**
 * The request's caller, once the request the handler decoded is the one it was admitted for
 * (`-32602 a2a.request-mismatch` otherwise: never act on a task the resolver did not see); a
 * context the binding did not admit is a wiring bug.
 */
export function callerOf(
  context: ServerCallContext,
  operation: A2AOperation,
  taskId = "",
): A2ARequestCaller {
  const found = context.state.get(CALLER) as A2ARequestCaller | undefined;
  // Stryker disable next-line StringLiteral: the invariant's text, never read while it holds
  if (found === undefined) throw new Error("an A2A call without an admitted caller");
  const { admitted } = found;
  checkedCallerIds(found);
  if (admitted.operation !== operation || admitted.taskId !== taskId)
    throw invalidParams(
      "a2a.request-mismatch",
      "the request is not the one its caller was admitted for",
    );
  return found;
}

/** A task not over and unchanged this long is read against its records (one lease period). */
const STALE_AFTER = EXECUTION_LEASE;
/** A task whose execution has not begun this long after its acceptance is settled (two leases). */
const START_TIMEOUT = (2 * EXECUTION_LEASE) as Milliseconds;

/**
 * A task as its records say it is (`repairedTask`); `forced`: checked now, whatever its age — after
 * its run here ended, when what the projection wrote is all there is to read.
 */
export const repairedOf = (
  parts: A2AServerParts,
  task: A2ATaskRecord,
  forced = false,
): Promise<A2ATaskRecord> =>
  repairedTask(
    {
      tasks: parts.tasks,
      control: parts.control,
      clock: parts.clock,
      staleAfter: forced ? (0 as Milliseconds) : STALE_AFTER,
      startTimeout: START_TIMEOUT,
    },
    task,
  );

/** The caller's task by its id, repaired; another owner's is "not found" too (spec §3.3). */
export async function ownedTask(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  taskId: string,
): Promise<A2ATaskRecord> {
  const key: A2ATaskKey = { tenantId: caller.tenantId, taskId };
  // the empty id, like every other that is no key's text, names no task
  const isKey = keyTextRuleOf(taskId) === undefined;
  const task = isKey ? await parts.tasks.findById(key) : undefined;
  if (task === undefined || task.ownerId !== caller.ownerId) throw taskNotFound();
  return repairedOf(parts, task);
}

/** What a log entry about a task names: its tenant, and its execution — the task's id. */
export const logSubjectOf = (key: A2ATaskKey): LogSubject => ({
  tenantId: key.tenantId,
  executionId: key.taskId,
});

export const taskKeyOf = (task: A2ATaskRecord): A2ATaskKey => ({
  tenantId: task.tenantId,
  taskId: task.taskId,
});

/** How many times a write lost to another writer is read and tried again. */
const ATTEMPTS = 3;

/**
 * A task no execution can start under any more (its id kept by a fence, or its only start refused)
 * ended with `status`, by compare-and-set — unless another writer ended it first: the task as it is.
 */
export async function endedUnstarted(
  parts: A2AServerParts,
  task: A2ATaskRecord,
  status: A2ATaskStatus,
): Promise<A2ATaskRecord> {
  let current = task;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (isTerminalA2ATaskState(current.status.state)) return current;
    const key = taskKeyOf(current);
    const written = await parts.tasks.compareAndSetStatus(
      key,
      current.version,
      status,
      parts.clock.now(),
    );
    if (written !== undefined) {
      taskChanged(key);
      return written;
    }
    const read = await parts.tasks.findById(key);
    if (read === undefined) throw taskNotFound();
    current = read;
  }
  parts.log.warn(
    "a2a.task-write-contended",
    `task ${current.taskId} changed ${String(ATTEMPTS)} times under its end: left to its read repair`,
    logSubjectOf(taskKeyOf(current)),
  );
  return current;
}
