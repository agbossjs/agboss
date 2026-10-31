import { ChildExecutionStatus } from "../../../flow/runtime/child-records.js";
import { ExecutionHistoryStatus } from "../../../infrastructure/execution-history.repository.js";
import type { FaultRun } from "../facts.js";
import { childCompletionsOf } from "./store-history.js";
import {
  BATCH_FINISH,
  batchesOf,
  ORDER_FINISH,
  orderExecutionsOf,
  type OrderExecution,
} from "./order-executions.js";
import { FaultInvariant, violation, type FaultViolation } from "./violations.js";

/**
 * Children once, no undo on a hand-over, every tree ended (#484 invariants 2, 4, 5):
 * - every order of a batch is one child of it, finished; no child's queue row completed twice;
 * - an order that finished undid nothing — no undo ran for it, its record lists none; one declined
 *   for real undid its reservation once;
 * - every order started has an execution that ended as it must — finished at the order's finish,
 *   or failed when it declined — and every batch finished with all its orders.
 */

/** The executions of each order. */
const byOrder = (
  executions: readonly OrderExecution[],
): ReadonlyMap<string, readonly OrderExecution[]> => {
  const orders = new Map<string, OrderExecution[]>();
  for (const execution of executions)
    orders.set(execution.orderId, [...(orders.get(execution.orderId) ?? []), execution]);
  return orders;
};

/** Every batch's children: each order once, finished; each completed in the queue once. */
function childrenViolations(run: FaultRun): FaultViolation[] {
  const found = batchesOf(run).flatMap((batch) => {
    const ids = batch.children.map((child) => child.executionId);
    const orders = batch.children.map((child) => (child.input as { orderId?: string }).orderId);
    const asked = (batch.input as readonly { orderId: string }[]).map((order) => order.orderId);
    const issues: FaultViolation[] = [];
    if (new Set(ids).size !== ids.length || [...asked].sort().join() !== [...orders].sort().join())
      issues.push(
        violation(
          FaultInvariant.ChildrenOnce,
          `batch ${batch.executionId} asked for ${asked.join(", ")} and has children ${orders.join(", ")}`,
        ),
      );
    for (const child of batch.children.filter(
      (each) => each.status !== ChildExecutionStatus.Finished,
    ))
      issues.push(
        violation(
          FaultInvariant.ChildrenOnce,
          `child ${child.executionId} of batch ${batch.executionId} is ${child.status}`,
        ),
      );
    return issues;
  });
  // the queue's own word, not an observer's: a child's row is completed once (#541's sibling, #484:
  // a parent recovered after a takeover hears its child's end again)
  const twice = [...childCompletionsOf(run.history)].filter(([, count]) => count > 1);
  return [
    ...found,
    ...twice.map(([id, count]) =>
      violation(
        FaultInvariant.ChildrenOnce,
        `child ${id} was completed ${String(count)} times in the queue`,
      ),
    ),
  ];
}

/** Undo only on a real failure. */
function undoViolations(
  run: FaultRun,
  execution: OrderExecution,
  isDeclined: boolean,
): FaultViolation[] {
  const released = run.events.filter(
    (event) => event.type === "released" && event.executionId === execution.executionId,
  );
  const recorded = execution.record?.compensations.length ?? 0;
  if (!isDeclined && (released.length > 0 || recorded > 0))
    return [
      violation(
        FaultInvariant.NoUndoOnHandOver,
        `${execution.orderId} (${execution.executionId}) did not fail, yet its reservation was undone (${String(released.length)} undo runs, ${String(recorded)} in its record)`,
      ),
    ];
  if (isDeclined && execution.record !== undefined && recorded !== 1)
    return [
      violation(
        FaultInvariant.NoUndoOnHandOver,
        `${execution.orderId} declined, and its record lists ${String(recorded)} undo actions, not 1`,
      ),
    ];
  return [];
}

/** How an order's executions must have ended. */
function endViolations(
  orderId: string,
  isDeclined: boolean,
  executions: readonly OrderExecution[],
): FaultViolation[] {
  const ended = executions.filter((execution) =>
    isDeclined
      ? execution.status === "failed"
      : execution.status === "finished" && execution.finish === ORDER_FINISH,
  );
  if (ended.length > 0) return [];
  const seen = executions
    .map((execution) => `${execution.executionId}: ${execution.status}`)
    .join(", ");
  return [
    violation(
      FaultInvariant.TreesFinish,
      `${orderId} never ${isDeclined ? "failed" : "finished"} (${seen === "" ? "no record" : seen})`,
    ),
  ];
}

/** Every violation of children once, undo only on failure, and trees that end. */
export function treeViolations(run: FaultRun): FaultViolation[] {
  const executions = byOrder(orderExecutionsOf(run));
  const declined = new Set(
    run.orders.filter((order) => order.decline).map((order) => order.orderId),
  );
  const orders = [...new Set(run.orders.map((order) => order.orderId))];
  const batches = batchesOf(run).filter(
    (batch) =>
      batch.status !== ExecutionHistoryStatus.Finished || batch.finish?.name !== BATCH_FINISH,
  );
  return [
    ...childrenViolations(run),
    ...orders.flatMap((orderId) => {
      const own = executions.get(orderId) ?? [];
      const isDeclined = declined.has(orderId);
      return [
        ...endViolations(orderId, isDeclined, own),
        ...own.flatMap((execution) => undoViolations(run, execution, isDeclined)),
      ];
    }),
    ...batches.map((batch) =>
      violation(FaultInvariant.TreesFinish, `batch ${batch.executionId} is ${batch.status}`),
    ),
  ];
}
