import type { HubRecord } from "../hub-inputs.js";

/**
 * Searching the kept executions of every input at once (#401 PR 6: what a file cannot — large record
 * sets read a page at a time, one search across the exports): by application, workflow, status,
 * a start window and a text found in an execution's, root's or thread's id, its workflow or its
 * application. Read-only.
 */

/** What a search asks for; every part optional. */
export interface RecordQuery {
  readonly application?: string;
  readonly workflow?: string;
  readonly status?: string;
  /** Started at or after (ISO 8601, compared as text: the records' own form). */
  readonly from?: string;
  /** Started before. */
  readonly to?: string;
  /** A text in its ids, workflow or application. */
  readonly text?: string;
  readonly offset: number;
  readonly limit: number;
}

/** One execution as the search lists it. */
export interface RecordSummary {
  readonly application: string;
  readonly workflow: string;
  readonly executionId: string;
  readonly rootExecutionId: string;
  readonly threadId: string;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly spendUsd: number;
  readonly file: string;
}

/** A page of matches, oldest start first. */
export interface RecordPage {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly records: readonly RecordSummary[];
}

/** The most one page lists. */
export const MAX_PAGE = 500;

/** The query of a request's parameters: unknown ones ignored, the page bounded. */
export function recordQueryOf(params: URLSearchParams): RecordQuery {
  const text = (name: string): Partial<Record<string, string>> => {
    const value = params.get(name);
    return value === null || value === "" ? {} : { [name]: value };
  };
  const whole = (name: string, fallback: number): number => {
    const value = Number(params.get(name) ?? Number.NaN);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  return {
    ...text("application"),
    ...text("workflow"),
    ...text("status"),
    ...text("from"),
    ...text("to"),
    ...(params.get("q") === null || params.get("q") === "" ? {} : { text: params.get("q") ?? "" }),
    offset: whole("offset", 0),
    limit: Math.min(Math.max(whole("limit", 50), 1), MAX_PAGE),
  };
}

const summaryOf = ({ file, record }: HubRecord): RecordSummary => ({
  application: record.application.name,
  workflow: record.workflow.name,
  executionId: record.executionId,
  rootExecutionId: record.rootExecutionId,
  threadId: record.threadId,
  status: record.status,
  startedAt: record.startedAt,
  ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
  spendUsd: record.spend.totalUsd,
  file,
});

const isWanted = (given: string | undefined, actual: string): boolean =>
  given === undefined || given === actual;

function matches(summary: RecordSummary, query: RecordQuery): boolean {
  const text = query.text?.toLowerCase();
  const found =
    text === undefined ||
    [
      summary.executionId,
      summary.rootExecutionId,
      summary.threadId,
      summary.workflow,
      summary.application,
    ].some((value) => value.toLowerCase().includes(text));
  return (
    found &&
    isWanted(query.application, summary.application) &&
    isWanted(query.workflow, summary.workflow) &&
    isWanted(query.status, summary.status) &&
    (query.from === undefined || summary.startedAt >= query.from) &&
    (query.to === undefined || summary.startedAt < query.to)
  );
}

/** The page of the records the query matches. */
export function searchRecords(records: readonly HubRecord[], query: RecordQuery): RecordPage {
  const found = records
    .map(summaryOf)
    .filter((summary) => matches(summary, query))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return {
    total: found.length,
    offset: query.offset,
    limit: query.limit,
    records: found.slice(query.offset, query.offset + query.limit),
  };
}
