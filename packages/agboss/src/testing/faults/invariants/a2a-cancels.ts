import { A2ATaskState } from "../../../infrastructure/a2a-task.repository.js";
import { FencedEffectStatus } from "../../../infrastructure/fenced-effect.repository.js";
import type { FaultRun, PodEventFact } from "../facts.js";
import { compareAt, type HistoryOperation, type OperationEvent } from "../operation-history.js";
import { StoreHoldPoint } from "../store-points.js";
import { FaultInvariant, violation, type FaultViolation } from "./violations.js";

/**
 * A canceled A2A task (#811 AC4, design §4.1.5, §4.3.2), on the store's own history — never on the
 * order the test heard things in:
 * - its cancel is anchored where it became durable: the first answer of its tree's `requestCancel`
 *   (#909: the mark every cancel writes first, in the lease store's database);
 * - a task told or written `CANCELED` committed no effect after that anchor — no fenced charge
 *   that ran, no payment intent recorded or claimed, asked after it was durable, but its undo's —,
 *   with no window: the fencing stores read the mark in the lease's transaction (#909); and it
 *   undid its reservation at most once; one told `CANCELED` with no cancel asked or written is a
 *   violation too;
 * - any tree with a durable cancel committed no effect after it either — canceled or not.
 */

/** A recorded value as a record (an operation's input, its output); `{}` for anything else. */
export const factsOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};

/** What an operation's complete answered, as a record. */
export const outputOf = (complete: OperationEvent | undefined): Readonly<Record<string, unknown>> =>
  factsOf(complete?.output);

/** Whether the operation is of the tree `rootId`: by its key (a root's lease) or its key's root (a child's). */
const isOfTree = ({ invoke }: HistoryOperation, rootId: string): boolean =>
  invoke.key === rootId || factsOf(invoke.input).rootExecutionId === rootId;

/**
 * The effects the tree `rootId` committed: fenced writes that ran, payment intents recorded and
 * new attempts claimed (#909) — never its undo's (the cancel's own unwinding, `isCompensation`).
 */
export const effectsOf = (run: FaultRun, rootId: string): readonly HistoryOperation[] =>
  run.history.operations.filter((operation) => {
    const { invoke, complete } = operation;
    if (!isOfTree(operation, rootId) || complete === undefined || complete.error !== undefined)
      return false;
    if (factsOf(invoke.input).isCompensation === true) return false;
    if (invoke.operation === StoreHoldPoint.FencedEffectWrite)
      return outputOf(complete).status === FencedEffectStatus.Ran;
    return (
      (invoke.operation === StoreHoldPoint.OutboundSaveIfAbsent ||
        invoke.operation === StoreHoldPoint.OutboundMarkPending) &&
      complete.output === true
    );
  });

/**
 * When the cancel of `rootId` became durable (#909: the first answer of its `requestCancel`, a
 * monotonic time), if it did. Every path that cancels a tree writes that mark first.
 */
export function cancelAnchorOf(run: FaultRun, rootId: string): string | undefined {
  const times = run.history.operations.flatMap(({ invoke, complete }) =>
    invoke.operation === StoreHoldPoint.LeaseRequestCancel &&
    invoke.key === rootId &&
    complete !== undefined &&
    complete.error === undefined
      ? [complete.at]
      : [],
  );
  return times.sort(compareAt)[0];
}

/** What a list of effects says: each operation and its process. */
const effectsText = (effects: readonly HistoryOperation[]): string =>
  effects.map(({ invoke }) => `${invoke.operation} by ${invoke.process}`).join(", ");

/** The effects of a canceled task committed after its cancel was durable: none, with no window (#909). */
function lateEffectViolations(run: FaultRun, taskId: string, anchor: string): FaultViolation[] {
  const after = effectsOf(run, taskId).filter(({ invoke }) => compareAt(invoke.at, anchor) > 0);
  if (after.length === 0) return [];
  return [
    violation(
      FaultInvariant.A2ATasksOnce,
      `task ${taskId} was canceled, yet committed ${effectsText(after)} after its cancel was durable`,
    ),
  ];
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
  const anchor = cancelAnchorOf(run, taskId);
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
  if (anchor !== undefined && isCanceled) issues.push(...lateEffectViolations(run, taskId, anchor));
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
