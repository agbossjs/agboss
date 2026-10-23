import { ExecutionHistoryStatus, type ExecutionHistoryRecord } from "agboss";
import type { HubEvalRun } from "./hub-inputs.js";

/**
 * An application's health as its files show it (#401 S2 Q5): derived from its kept executions and
 * its eval runs only — no live probe (a static page cannot poll, and the Hub reaches no URL). Live
 * health stays the orchestrator's (`app.checkReadiness()`).
 */

/** What the kept executions say. */
export interface RecordsHealth {
  readonly executions: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly paused: number;
  /** Failed out of the ended ones, 0–1; 0 with none ended. */
  readonly failureRate: number;
  /** The `limit.*` and `mesh.*` codes the failures carried (their own or a cause's), with counts. */
  readonly errorCodes: Readonly<Record<string, number>>;
  /** The 95th percentile of the ended executions' durations, in ms; undefined with none ended. */
  readonly p95DurationMs: number | undefined;
  readonly spendUsd: number;
  /** Spend per UTC day of their starts, oldest first. */
  readonly spendByDay: readonly { readonly day: string; readonly usd: number }[];
}

/** The latest run of one suite: what pass^k says now. */
export interface SuiteHealth {
  readonly suite: string;
  readonly workflow: string;
  readonly file: string;
  readonly endedAt: string;
  readonly cases: number;
  readonly passAtK: number;
  readonly passHatK: number;
  readonly unstable: number;
  /** How many times each case ran. */
  readonly runs: number;
}

const WATCHED_CODES = /^(limit|mesh)\./u;

interface ErrorLike {
  readonly code: string;
  readonly cause?: ErrorLike;
}

/** The watched codes of an error and its causes. */
function watchedCodes(error: ErrorLike | undefined): string[] {
  if (error === undefined) return [];
  const own = WATCHED_CODES.test(error.code) ? [error.code] : [];
  return [...own, ...watchedCodes(error.cause)];
}

const count = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

/** The nearest-rank 95th percentile. */
function p95(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

function spendByDayOf(records: readonly ExecutionHistoryRecord[]) {
  const days = new Map<string, number>();
  for (const record of records) {
    const day = record.startedAt.slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + record.spend.totalUsd);
  }
  return [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, usd]) => ({ day, usd }));
}

/** What an application's kept executions say. */
export function recordsHealthOf(records: readonly ExecutionHistoryRecord[]): RecordsHealth {
  const withStatus = (status: ExecutionHistoryStatus): number =>
    records.filter((record) => record.status === status).length;
  const failed = withStatus(ExecutionHistoryStatus.Failed);
  const cancelled = withStatus(ExecutionHistoryStatus.Cancelled);
  const ended = records.filter((record) => record.endedAt !== undefined);
  const durations = ended.map(
    (record) => Date.parse(record.endedAt ?? "") - Date.parse(record.startedAt),
  );
  return {
    executions: records.length,
    failed,
    cancelled,
    paused: withStatus(ExecutionHistoryStatus.Paused),
    failureRate: ended.length === 0 ? 0 : failed / ended.length,
    errorCodes: count(records.flatMap((record) => watchedCodes(record.error))),
    p95DurationMs: p95(durations.filter((duration) => Number.isFinite(duration) && duration >= 0)),
    spendUsd: records.reduce((total, record) => total + record.spend.totalUsd, 0),
    spendByDay: spendByDayOf(records),
  };
}

/** The latest run of each suite of an application, by suite. */
export function suitesHealthOf(runs: readonly HubEvalRun[]): SuiteHealth[] {
  const latest = new Map<string, HubEvalRun>();
  for (const run of runs) {
    const seen = latest.get(run.report.suite);
    if (seen === undefined || seen.report.endedAt < run.report.endedAt)
      latest.set(run.report.suite, run);
  }
  return [...latest.values()]
    .map(({ file, report }) => ({
      suite: report.suite,
      workflow: report.workflow.name,
      file,
      endedAt: report.endedAt,
      cases: report.summary.cases,
      passAtK: report.summary.passAtK,
      passHatK: report.summary.passHatK,
      unstable: report.summary.unstable,
      runs: report.runs,
    }))
    .sort((left, right) => left.suite.localeCompare(right.suite));
}
