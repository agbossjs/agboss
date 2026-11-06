import { TaskState, type ListTasksRequest, type ListTasksResponse } from "@a2a-js/sdk";
import {
  A2ATaskState,
  InvalidA2APageTokenError,
  type A2ATaskPage,
} from "../../infrastructure/a2a-task.repository.js";
import { repairedOf, type A2ARequestCaller, type A2AServerParts } from "./a2a-server-parts.js";
import { wireTaskOf } from "./a2a-task-view.js";
import { invalidParams } from "./a2a-wire-errors.js";

/**
 * `ListTasks` (#808, spec §3.1.4): the caller's tasks only, newest status first, filtered by
 * context, state and `statusTimestampAfter` in the store, each repaired as a read is, a page at a
 * time — `nextPageToken` always there, `""` on the last page. `totalSize` is every task the filters
 * match before paging, `pageSize` the page size used (#824).
 */

/** The page size when the caller gives none, and the most it may ask. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** The kept state a wire state filter names; `undefined` for none. */
function stateFilterOf(state: TaskState): A2ATaskState | undefined {
  if (state === TaskState.TASK_STATE_UNSPECIFIED) return undefined;
  const name = TaskState[state] as string | undefined;
  const found = Object.values(A2ATaskState).find((kept) => kept === name);
  if (found === undefined) throw invalidParams("a2a.unknown-state", "no such task state");
  return found;
}

/** The time `statusTimestampAfter` names; `undefined` for none. */
function statusAtAfterOf(params: ListTasksRequest): Date | undefined {
  if (params.statusTimestampAfter === undefined) return undefined;
  const after = Date.parse(params.statusTimestampAfter);
  if (Number.isNaN(after))
    throw invalidParams("a2a.invalid-timestamp", "statusTimestampAfter is not an RFC 3339 time");
  return new Date(after);
}

/** The page size asked, else the default; one out of 1 to 100 is `-32602`. */
function pageSizeOf(params: ListTasksRequest): number {
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
    throw invalidParams("a2a.page-size", "pageSize is a whole number from 1 to 100");
  return pageSize;
}

/** The store's page; a token it did not give is `-32602`. */
async function pageOf(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  params: ListTasksRequest,
  pageSize: number,
): Promise<A2ATaskPage> {
  const state = stateFilterOf(params.status);
  const statusAtAfter = statusAtAfterOf(params);
  try {
    return await parts.tasks.list({
      tenantId: caller.tenantId,
      ownerId: caller.ownerId,
      ...(params.contextId === "" ? {} : { contextId: params.contextId }),
      ...(state === undefined ? {} : { state }),
      ...(statusAtAfter === undefined ? {} : { statusAtAfter }),
      pageSize,
      pageToken: params.pageToken,
    });
  } catch (error) {
    if (!(error instanceof InvalidA2APageTokenError)) throw error;
    throw invalidParams("a2a.invalid-page-token", "the page token is not one this agent gave");
  }
}

/** A page of the caller's tasks on the wire. */
export async function listedTasks(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  params: ListTasksRequest,
): Promise<ListTasksResponse> {
  const pageSize = pageSizeOf(params);
  const page = await pageOf(parts, caller, params, pageSize);
  const repaired = await Promise.all(page.tasks.map((task) => repairedOf(parts, task)));
  const wire = repaired.map((task) => {
    const shown = wireTaskOf(task, parts.skills);
    return params.includeArtifacts === true ? shown : { ...shown, artifacts: [] };
  });
  return {
    tasks: wire,
    nextPageToken: page.nextPageToken,
    pageSize,
    totalSize: page.totalSize,
  };
}
