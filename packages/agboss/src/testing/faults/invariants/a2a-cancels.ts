import { CANCEL_REQUEST_KEY } from "../../../app/cancel-requests.js";
import { EXECUTION_LEASE } from "../../../app/lease-fence.js";
import { A2ATaskState } from "../../../infrastructure/a2a-task.repository.js";
import { FencedEffectStatus } from "../../../infrastructure/fenced-effect.repository.js";
import type { FaultRun, PodEventFact } from "../facts.js";
import { compareAt, type HistoryOperation, type OperationEvent } from "../operation-history.js";
import { StoreHoldPoint } from "../store-points.js";
import { FaultInvariant, violation, type FaultViolation } from "./violations.js";

/**
 * A canceled A2A task (#811 AC4, design §4.1.5, §4.3.2), on the store's own history — never on the
 * order the test heard things in:
 * - its cancel is anchored where it became durable: the first of its tree's cancel request (the
 *   tree store's `@agboss/cancel-request`) and a status write carrying it (`cancelRequested`, or
 *   `CANCELED` itself);
 * - a task told or written `CANCELED` committed no effect after that anchor — no fenced charge
 *   that ran, no payment intent recorded, asked after it was durable — and undid its reservation
 *   at most once; one told `CANCELED` with no cancel asked or written is a violation too;
 * - any tree with a cancel request committed no effect more than one lease of store time after
 *   it: its holder reads the request at its next renewal, so a later effect is a cancel it never
 *   read.
 */

/** A recorded value as a record (an operation's input, its output); `{}` for anything else. */
export const factsOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};

/** What an operation's complete answered, as a record. */
export const outputOf = (complete: OperationEvent | undefined): Readonly<Record<string, unknown>> =>
  factsOf(complete?.output);

/** The effects the tree `rootId` committed: fenced writes that ran, payment intents recorded. */
export const effectsOf = (run: FaultRun, rootId: string): readonly HistoryOperation[] =>
  run.history.operations.filter(({ invoke, complete }) => {
    if (invoke.key !== rootId || complete === undefined || complete.error !== undefined)
      return false;
    if (invoke.operation === StoreHoldPoint.FencedEffectWrite)
      return outputOf(complete).status === FencedEffectStatus.Ran;
    return invoke.operation === StoreHoldPoint.OutboundSaveIfAbsent;
  });

/** When the cancel of `taskId` became durable (a monotonic time), if it did. */
function cancelAnchorOf(
  run: FaultRun,
  taskId: string,
  writes: readonly HistoryOperation[],
): string | undefined {
  const requests = run.history.operations.filter(
    ({ invoke, complete }) =>
      invoke.operation === StoreHoldPoint.TreeSaveIfAbsent &&
      invoke.key === CANCEL_REQUEST_KEY &&
      factsOf(invoke.input).rootExecutionId === taskId &&
      outputOf(complete).saved === true,
  );
  const carried = writes.filter(({ complete }) => {
    const written = outputOf(complete);
    return written.cancelRequested === true || written.state === A2ATaskState.Canceled;
  });
  const times = [...requests, ...carried].flatMap(({ complete }) =>
    complete === undefined ? [] : [complete.at],
  );
  return times.sort(compareAt)[0];
}

/** One lease of store time, in the history's monotonic nanoseconds. */
const leaseNanosOf = (run: FaultRun): bigint =>
  BigInt(Math.round((EXECUTION_LEASE / (run.timeScale ?? 1)) * 1e6));

/** What a list of effects says: each operation and its process. */
const effectsText = (effects: readonly HistoryOperation[]): string =>
  effects.map(({ invoke }) => `${invoke.operation} by ${invoke.process}`).join(", ");

/** Effects committed after the anchor — any, for a canceled task; past a lease, for any tree. */
function lateEffectViolations(
  run: FaultRun,
  taskId: string,
  anchor: string,
  isCanceled: boolean,
): FaultViolation[] {
  const after = effectsOf(run, taskId).filter(({ invoke }) => compareAt(invoke.at, anchor) > 0);
  const pastLease = after.filter(
    ({ invoke }) => BigInt(invoke.at) - BigInt(anchor) > leaseNanosOf(run),
  );
  if (isCanceled && after.length > 0)
    return [
      violation(
        FaultInvariant.A2ATasksOnce,
        `task ${taskId} was canceled, yet committed ${effectsText(after)} after its cancel was durable`,
      ),
    ];
  if (pastLease.length > 0)
    return [
      violation(
        FaultInvariant.A2ATasksOnce,
        `task ${taskId} committed ${effectsText(pastLease)} more than a lease after its tree's cancel request: its holder never read it`,
      ),
    ];
  return [];
}

/** Every violation of a canceled task, and of a tree that went on past its cancel request. */
export function canceledViolations(
  run: FaultRun,
  taskId: string,
  answers: readonly PodEventFact[],
  writes: readonly HistoryOperation[],
): FaultViolation[] {
  const isCanceled =
    answers.some((answer) => answer.state === A2ATaskState.Canceled) ||
    writes.some(({ complete }) => outputOf(complete).state === A2ATaskState.Canceled);
  const anchor = cancelAnchorOf(run, taskId, writes);
  const asked = run.events.some(
    (event) =>
      event.type === "a2a-asked" && event.method === "CancelTask" && event.taskId === taskId,
  );
  const issues: FaultViolation[] = [];
  if (isCanceled && anchor === undefined && !asked)
    issues.push(
      violation(
        FaultInvariant.A2ATasksOnce,
        `task ${taskId} was told CANCELED, yet no cancel was asked or written`,
      ),
    );
  if (anchor !== undefined) issues.push(...lateEffectViolations(run, taskId, anchor, isCanceled));
  const released = run.events.filter(
    (event) => event.type === "released" && event.rootExecutionId === taskId,
  );
  if (isCanceled && released.length > 1)
    issues.push(
      violation(
        FaultInvariant.A2ATasksOnce,
        `task ${taskId} was canceled, and its reservation was released ${String(released.length)} times`,
      ),
    );
  return issues;
}
