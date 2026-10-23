import type {
  ExecutionHistoryRecord,
  ExecutionHistoryRepository,
} from "./execution-history.repository.js";

/**
 * The export of kept executions (#401 PR 1, `agboss records export`): JSON Lines, one record per
 * line, each self-describing — `{ "kind": "agboss.execution-record", "schema": 1, …record }` — so
 * a reader recognises the file by its lines, not by its name or folder. The records are masked as
 * they were kept.
 */

/** The marker of an exported record. */
export const EXECUTION_RECORD_KIND = "agboss.execution-record";

/** The version of an exported record's shape. */
export const EXECUTION_RECORD_SCHEMA = 1;

/** Which kept records an export reads: one tenant's, or every tenant's, started in `[from, to)`. */
export interface HistoryExportQuery {
  /** The tenant; `undefined` = every tenant (`--all-tenants`). */
  readonly tenantId: string | undefined;
  readonly from: Date;
  readonly to: Date;
}

/** How many records one page reads. */
const PAGE_SIZE = 500;

/** One exported line: the marker, then the record. */
export const exportedRecordLine = (record: ExecutionHistoryRecord): string =>
  JSON.stringify({ kind: EXECUTION_RECORD_KIND, schema: EXECUTION_RECORD_SCHEMA, ...record });

/** The records of `query`, oldest start first, read page by page. */
export async function* historyRecordsOf(
  history: ExecutionHistoryRepository,
  query: HistoryExportQuery,
): AsyncGenerator<ExecutionHistoryRecord> {
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = { offset, limit: PAGE_SIZE };
    const found =
      query.tenantId === undefined
        ? await history.findAllByStartedAtBetween(query.from, query.to, page)
        : await history.findAllByTenantIdAndStartedAtBetween(
            query.tenantId,
            query.from,
            query.to,
            page,
          );
    yield* found;
    if (found.length < PAGE_SIZE) return;
  }
}
