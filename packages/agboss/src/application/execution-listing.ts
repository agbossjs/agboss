import type { ExecutionsQuery, AnyTenantApp } from "../app/types.js";
import type { Page } from "../app/page.js";
import { DtoValidationError } from "../dto/errors.js";
import { tenantRead } from "../flow/context/context-values.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import type {
  ExecutionHistoryQuery,
  ExecutionHistoryRecord,
  ExecutionHistoryRepository,
} from "../infrastructure/execution-history.repository.js";

/**
 * `app.getExecution` and `app.listExecutions` (#1324e): the root executions the application keeps
 * (`@Workflow({ historyTtl })`), read from the history store of the instance. The tenant is already
 * decided by the caller of these functions (named, or `"default"` for an application without a
 * `tenantContext`); a listing never reads another tenant's records unless `allTenants` was asked.
 */

/** The DTO a refused query names. */
const QUERY = "ExecutionsQuery";

/** The most records one page holds. */
const MAX_LIMIT = 1000;

/** What the listing reads after the tenant is decided. */
export interface ExecutionListing {
  readonly tenantId?: string | undefined;
  readonly allTenants?: boolean | undefined;
}

const refused = (path: string, reason: string): never => {
  throw new DtoValidationError({ dto: QUERY, issues: [{ path, reason }] });
};

/** A time bound: a valid `Date`, or an ISO 8601 text. */
function boundOf(path: string, value: Date | string | undefined, fallback: Date): Date {
  if (value === undefined) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? refused(path, "a time is a valid Date or an ISO 8601 text")
    : date;
}

/** The records of a tenant's history: one by its id. */
export async function getExecutionIn(
  history: ExecutionHistoryRepository,
  executionId: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<ExecutionHistoryRecord | undefined> {
  return tenantRead(tenantId, () => history.findByTenantIdAndExecutionId(tenantId, executionId));
}

/** The page window of a query, checked: its limit, cursor and time bounds. */
function windowOf(query: ExecutionsQuery): ExecutionHistoryQuery {
  const { limit, cursor } = query;
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT))
    refused("limit", `a page is a whole number of executions from 1 to ${String(MAX_LIMIT)}`);
  if (cursor !== undefined && (typeof cursor !== "string" || cursor === ""))
    refused("cursor", "a cursor is the nextCursor of a page before: a non-empty text");
  return {
    from: boundOf("startedAfter", query.startedAfter, new Date(0)),
    to: boundOf("startedBefore", query.startedBefore, new Date("9999-12-31T23:59:59.999Z")),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** Whether a record is one the query's workflow and status filters keep. */
function keeps(record: ExecutionHistoryRecord, { workflow, status }: ExecutionsQuery): boolean {
  const statuses = status === undefined ? undefined : ([] as unknown[]).concat(status);
  return (
    (workflow === undefined || record.workflow.name === workflow) &&
    (statuses === undefined || statuses.includes(record.status))
  );
}

/** A page of the history (oldest start first), filtered by workflow and status after the store's page. */
export async function listExecutionsIn(
  history: ExecutionHistoryRepository,
  query: ExecutionsQuery,
): Promise<Page<ExecutionHistoryRecord>> {
  const paging = windowOf(query);
  const { allTenants, tenantId = DEFAULT_TENANT_ID } = query as ExecutionListing;
  const read = async (): Promise<Page<ExecutionHistoryRecord>> =>
    allTenants === true
      ? history.findAllByStartedAtBetween(paging)
      : tenantRead(tenantId, () =>
          history.findAllByTenantIdAndStartedAtBetween({ ...paging, tenantId }),
        );
  const page = await read().catch((error: unknown) =>
    error instanceof RangeError
      ? refused("cursor", "a cursor is the nextCursor of a page before, as the store gave it")
      : Promise.reject(error as Error),
  );
  const items = page.items.filter((record) => keeps(record, query));
  return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor };
}

/** `app.getExecution` and `app.listExecutions` of an instance over its history store. */
export const executionReadsOf = (
  history: ExecutionHistoryRepository,
): Pick<AnyTenantApp, "getExecution" | "listExecutions"> => ({
  getExecution: async (executionId, options) =>
    getExecutionIn(history, executionId, options?.tenantId),
  listExecutions: async (query) => listExecutionsIn(history, query ?? {}),
});
