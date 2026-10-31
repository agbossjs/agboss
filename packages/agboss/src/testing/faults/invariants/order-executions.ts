import type { ExecutionHistoryRecord } from "../../../infrastructure/execution-history.repository.js";
import type { ChildExecutionRecord } from "../../../flow/runtime/child-records.js";
import type { FaultRun } from "../facts.js";

/**
 * The executions of the fixture's orders in a run's kept records (#484): each root order tree, and
 * each order child of a batch (in its root's `children`) — with its order, its end and its tree.
 */

/** The start names of the fixture's workflows. */
export const ORDER_START = "fault-order-workflow-start";
export const ORDER_FINISH = "fault-order-workflow-finish";
export const BATCH_START = "fault-batch-workflow-start";
export const BATCH_FINISH = "fault-batch-workflow-finish";

/** One execution of an order. */
export interface OrderExecution {
  readonly orderId: string;
  readonly executionId: string;
  readonly rootExecutionId: string;
  /** `finished`, `failed`, `cancelled` (or `paused` / `running` for a root that never ended). */
  readonly status: string;
  readonly finish: string | undefined;
  readonly output: unknown;
  /** A root's own record; a child's is in its root's. */
  readonly record?: ExecutionHistoryRecord;
}

/** The order an execution's input names. */
const orderIdOf = (input: unknown): string =>
  typeof input === "object" && input !== null && "orderId" in input ? String(input.orderId) : "";

/** A batch child's execution. */
const childOf = (child: ChildExecutionRecord): OrderExecution => ({
  orderId: orderIdOf(child.input),
  executionId: child.executionId,
  rootExecutionId: child.rootExecutionId,
  status: child.status,
  finish: child.finish?.name,
  output: child.output,
});

/** Every order execution of the run's records. */
export function orderExecutionsOf(run: FaultRun): readonly OrderExecution[] {
  return run.records.flatMap((record): OrderExecution[] => {
    if (record.start.name === ORDER_START)
      return [
        {
          orderId: orderIdOf(record.input),
          executionId: record.executionId,
          rootExecutionId: record.rootExecutionId,
          status: record.status,
          finish: record.finish?.name,
          output: record.output,
          record,
        },
      ];
    return record.children.map(childOf);
  });
}

/** The batch roots of the run's records. */
export const batchesOf = (run: FaultRun): readonly ExecutionHistoryRecord[] =>
  run.records.filter((record) => record.start.name === BATCH_START);
