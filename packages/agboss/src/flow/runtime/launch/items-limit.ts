import { errorRecordOf } from "../../../core/error-record.js";
import { LimitError } from "../../../core/error-families/limit-errors.js";
import { usd } from "../../../units/index.js";
import { isStrictItems } from "../../analyse/flow-graph.js";
import type { RuntimeNode } from "../graph-model.js";
import { errorHandlerOf } from "../graph-model.js";
import { sidePathEntered } from "../limits.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import { handledErrorOf, type ComponentRecords } from "../workflow-keys.js";
import type { LaunchTicket } from "./records.js";
import type { RuntimeLaunch } from "./runtime-launch.js";

/**
 * `.forEachItem(step, { maxItems })` (#1280): a list longer than `maxItems` is an error, never a
 * quiet slice. The launching step has already written its list (its value is in the scope), no branch
 * was dispatched and nothing was spent past the producer; the failure is `LimitError.Items`, taken by
 * the join's `.onError(…)` handler — a required one (`[launch.max-items-handler-required]`).
 */

/** The `maxItems` a launch's list passed (a strict per-item launch, #1280); undefined when it did not. */
function limitPassedBy(launch: RuntimeLaunch, ticket: LaunchTicket): number | undefined {
  const limit = launch.launch.maxItems;
  return isStrictItems(launch.launch) && ticket.items > (limit ?? Infinity) ? limit : undefined;
}

/** Whether a launch's list passed its `maxItems`: nothing is dispatched then. */
export const isItemsOverflow = (launch: RuntimeLaunch, ticket: LaunchTicket): boolean =>
  limitPassedBy(launch, ticket) !== undefined;

/** The way out of a launch whose list passed `maxItems`; undefined when it did not. */
export function itemsOverflowOf(
  launched: { readonly launch: RuntimeLaunch; readonly ticket: LaunchTicket },
  node: RuntimeNode,
  state: ExecutionStateType,
  records: ComponentRecords,
): { readonly stoppedBy: ExecutionStateUpdate; readonly failure: Error } | undefined {
  const { launch, ticket } = launched;
  const limit = limitPassedBy(launch, ticket);
  if (limit === undefined) return undefined;
  const error = new LimitError.Items({
    path: [...state.path, node.id],
    spentUsd: usd(0),
    node: node.id,
    limit,
    actual: ticket.items,
  });
  return { stoppedBy: joinErrorTaken({ launch, node, state, records }, error), failure: error };
}

/**
 * Where a launch's failure goes at dispatch: the update of the join's `.onError(…)` handler's side
 * path. The visit then undoes what the execution's children held (#1281 (10), `heldEntriesUndone`),
 * as a failed join does, once its own entries are open.
 */
export function joinErrorTaken(
  site: {
    readonly launch: RuntimeLaunch;
    readonly node: RuntimeNode;
    readonly state: ExecutionStateType;
    readonly records: ComponentRecords;
  },
  error: Error,
): ExecutionStateUpdate {
  const { launch, node, state, records } = site;
  const record = errorRecordOf(error);
  const handler = errorHandlerOf({ errors: launch.joinErrors }, record);
  if (handler === undefined) throw error;
  const handled = handledErrorOf(records, record, node.id, handler.to);
  return {
    lastError: record,
    next: handler.to,
    handledErrors: [handled],
    ...sidePathEntered(state, record, handler.to, node, handled),
  };
}
