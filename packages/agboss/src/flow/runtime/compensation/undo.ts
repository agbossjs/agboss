import { handedOverReason } from "../../../app/handed-over.js";
import { errorRecordOf, type ErrorRecord } from "../../../core/error-record.js";
import type { ExecutionObserverManager } from "../../../core/observer-manager.js";
import type { Class } from "../../../components/injection.js";
import type { UsageRecord } from "../../../finops/usage.js";
import type { Clock } from "../../../infrastructure/clock.js";
import { timeoutError, timeoutOn } from "../../../infrastructure/clock-timeout.js";
import type { Milliseconds } from "../../../units/index.js";
import type { ResolvedField } from "../../analyse/fields.js";
import { actionDeclarationOf } from "../../analyse/compensation.js";
import { slotOfField } from "../../analyse/scope.js";
import {
  CompensationEntryStatus,
  CompensationStatus,
  type CompensationEntry,
  type CompensationReason,
  type CompensationRecord,
} from "../../compensation.js";
import { compensationKeyOf } from "../../context/idempotency.js";
import { runInFrame, type ExecutionFacts, type FrameSpec } from "../../context/frame.js";
import type { StepDescriptor } from "../../context/execution-context.js";
import type { ActionDeclaration } from "../../decorators/declaration.js";
import { reportNodeEvent } from "../../observers/execution-event.js";
import type { RuntimeGraph } from "../graph-model.js";
import { ComponentKind, plainRecordOf, type ComponentRecord } from "../records.js";
import { readInput } from "../scope.js";
import { inStepEntry, type StepEntries } from "../step-entries.js";
import { recordOfComponent } from "../workflow-keys.js";

/**
 * One automatic undo (#340): the undo action of an open entry runs in its own frame — its step the
 * undo action's, its key `<compensated key>:compensation`, `step.compensates` the step it undoes —
 * on what the entry's snapshot holds, with a clean-up signal of its own: it aborts after
 * `compensationTimeout`, or when the execution's lease is lost or the app stops; the execution's
 * own cancel does not. No tree or instance slot, no budget check; its services' spend is returned
 * with it. `onCompensationStart` / `onCompensationEnd` around it, the action's own events inside.
 */

/** Where an automatic undo runs. */
export interface UndoSite {
  readonly graph: RuntimeGraph;
  readonly container: { readonly get: <T>(token: Class<T>) => T };
  readonly components: ReadonlyMap<string, ComponentRecord>;
  readonly observer?: ExecutionObserverManager | undefined;
  /** The undoing execution (its `signal`: the execution's, watched for a hand-over only). */
  readonly execution: ExecutionFacts;
  readonly clock: Clock;
  readonly timeout: Milliseconds;
  readonly stepEntries?: StepEntries | undefined;
  readonly reason: CompensationReason;
}

/** An undo that ran: its entry, closed, and what its services cost. */
export interface Undone {
  readonly entry: CompensationEntry;
  readonly usage: readonly UsageRecord[];
}

/** What an action is: `execute(input)`. */
interface ExecutableAction {
  execute(input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

const isExecutable = (value: unknown): value is ExecutableAction =>
  typeof value === "object" &&
  value !== null &&
  "execute" in value &&
  typeof value.execute === "function";

/** The undo action's fields, resolved like a node's (it need not be a node of the graph). */
const fieldsOf = (undo: ActionDeclaration): readonly ResolvedField[] =>
  Object.entries(undo.options.input ?? {}).map(([name, shape]) => ({
    name,
    label: `${undo.options.name}.${name}`,
    shape,
    ...slotOfField(shape),
    isPassThrough: false,
  }));

/** The clean-up signal: the bound, a lost lease, the app's stop — never the execution's cancel. */
function cleanUpSignalOf(site: UndoSite): { readonly signal: AbortSignal; release: () => void } {
  const timeout = timeoutOn(site.clock, site.timeout, timeoutError);
  const handedOver = new AbortController();
  const run = site.execution.signal;
  const watch = (): void => {
    const reason = handedOverReason(run);
    if (reason !== undefined) handedOver.abort(reason);
  };
  if (run.aborted) watch();
  else run.addEventListener("abort", watch, { once: true });
  return {
    signal: AbortSignal.any([timeout.signal, handedOver.signal]),
    release: (): void => {
      timeout.release();
      run.removeEventListener("abort", watch);
    },
  };
}

/** The undo action's class and declaration, named by the compensated action's own. */
function undoActionOf(site: UndoSite, entry: CompensationEntry): [Class, ActionDeclaration] {
  const undo = actionDeclarationOf(site.graph.nodes.get(entry.action)?.component)?.options
    .compensateWith;
  const declaration = actionDeclarationOf(undo);
  if (undo === undefined || declaration === undefined)
    throw new TypeError(`${entry.action} has no compensateWith action to undo it`);
  return [undo, declaration];
}

/** The undo's frame: the execution's facts on the clean-up signal, the undo action's step. */
function frameOf(site: UndoSite, entry: CompensationEntry, signal: AbortSignal): FrameSpec {
  const [type] = undoActionOf(site, entry);
  const record = recordOfComponent(site.components, entry.compensator, ComponentKind.Action);
  const step: StepDescriptor = {
    component: Object.freeze({ type, ...record }),
    nodeId: entry.compensator,
    visitNumber: entry.compensated.visitNumber,
    idempotencyKey: compensationKeyOf(entry.key),
    callId: undefined,
    itemIndex: entry.compensated.itemIndex,
    copyNumber: 1,
    toolLoopIteration: undefined,
    validationAttempts: 0,
    compensates: entry.compensated,
  };
  return { execution: Object.freeze({ ...site.execution, signal }), step: Object.freeze(step) };
}

/** Runs the undo action and reports it; what it threw, or `undefined` when it returned. */
async function ranUndo(site: UndoSite, entry: CompensationEntry): Promise<ErrorRecord | undefined> {
  const [type, declaration] = undoActionOf(site, entry);
  const instance: unknown = site.container.get(type);
  if (!isExecutable(instance)) throw new TypeError(`${entry.compensator} has no execute(input)`);
  const view = { scope: entry.input, outdatedValues: [] };
  const input = readInput(site.graph, { fields: fieldsOf(declaration) }, view).fields;
  const name = entry.compensator;
  const { compensated, reason } = { compensated: entry.compensated, reason: site.reason };
  await reportNodeEvent((base) =>
    site.observer?.onCompensationStart({ ...base, compensated, reason }),
  );
  await reportNodeEvent((base) => site.observer?.onActionStart({ ...base, name, input }));
  let error: ErrorRecord | undefined;
  try {
    const update: unknown = await instance.execute(input);
    await reportNodeEvent((base) => site.observer?.onActionEnd({ ...base, name, update }));
  } catch (thrown) {
    error = errorRecordOf(thrown);
  }
  const status = error === undefined ? CompensationStatus.Compensated : CompensationStatus.Failed;
  const ended = { compensated, reason, status, ...(error === undefined ? {} : { error }) };
  await reportNodeEvent((base) => site.observer?.onCompensationEnd({ ...base, ...ended }));
  return error;
}

/**
 * Undoes one open entry: its undo action run, its entry closed with the record of it. A lost lease
 * or the app's stop meanwhile is no outcome of the undo: it is thrown as it is (another instance
 * goes on).
 */
export async function undone(entry: CompensationEntry, site: UndoSite): Promise<Undone> {
  const usage: UsageRecord[] = [];
  const cleanUp = cleanUpSignalOf(site);
  const frame: FrameSpec = {
    ...frameOf(site, entry, cleanUp.signal),
    services: {
      reportUsage: (record: UsageRecord): void => {
        usage.push({ ...record, caller: `action:${entry.compensator}` });
      },
    },
  };
  const startedAt = site.clock.now();
  try {
    const error = await inStepEntry(site.stepEntries, frame, () =>
      runInFrame(frame, () => ranUndo(site, entry)),
    );
    const handedOver = handedOverReason(site.execution.signal);
    if (handedOver !== undefined) throw handedOver;
    const record: CompensationRecord = {
      compensated: entry.compensated,
      compensator: plainRecordOf(frame.step.component),
      reason: site.reason,
      status: error === undefined ? CompensationStatus.Compensated : CompensationStatus.Failed,
      ...(error === undefined ? {} : { error }),
      startedAt: startedAt.toISOString(),
      endedAt: site.clock.now().toISOString(),
    };
    return { entry: { ...entry, status: CompensationEntryStatus.Closed, undo: record }, usage };
  } finally {
    cleanUp.release();
  }
}
