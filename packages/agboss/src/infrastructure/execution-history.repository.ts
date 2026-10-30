import { Injectable } from "../components/decorators.js";
import type { ErrorRecord } from "../core/error-record.js";
import type { WorkflowRecord } from "../flow/context/execution-context.js";
import type { ExecutionRecord } from "../flow/runtime/execution-record.js";
import type { ComponentRecord } from "../flow/runtime/records.js";
import type { ExecutionLeaseEventRecord } from "./execution-lease-event.repository.js";
import type { OutboundCallRecord } from "./outbound-call.repository.js";
import { IN_MEMORY_DATABASE } from "./instance-tokens.js";
import type { InMemoryDatabase } from "./in-memory-database.js";

/**
 * Infrastructure (#401 PR 1, S2 Q2 / Q3): the history of an application's root executions — one
 * `ExecutionHistoryRecord` each, its `ExecutionRecord` with who and what it was, PII-masked as its
 * traces are. Kept only when `@Application({ executionRecordRetention })` says how long (unset →
 * nothing is kept), saved when its tree rests or ends and removed by the recovery sweep on the
 * `Clock` once it ended longer ago than that. Listed only in `@Application({ providers })`; the
 * built-in default is in memory, `SqliteExecutionHistoryRepository` keeps it in the application's
 * SQLite file. `agboss records export` reads it.
 */

/** How a kept execution stands: resting at a pause, or ended. */
export enum ExecutionHistoryStatus {
  Paused = "paused",
  Finished = "finished",
  Failed = "failed",
  Cancelled = "cancelled",
}

/** The application instance that wrote a record. */
export interface ApplicationRecord {
  readonly name: string;
  readonly version: string;
  readonly instanceId: string;
}

/** The context values an execution ran with (#261), masked: its tenant and its execution fields. */
export interface ExecutionContextRecord {
  readonly tenant: Readonly<Record<string, unknown>>;
  readonly execution: Readonly<Record<string, unknown>>;
}

/** One root execution as the history keeps it: its record and its identity. */
export interface ExecutionHistoryRecord extends ExecutionRecord {
  readonly executionId: string;
  /** Its tree's root: its own id (only roots are kept; its children are in `children`). */
  readonly rootExecutionId: string;
  /** The execution it was launched by; none for a root (a mesh caller is its `origin`). */
  readonly parentExecutionId?: string;
  readonly threadId: string;
  readonly tenantId: string;
  readonly application: ApplicationRecord;
  readonly workflow: WorkflowRecord;
  readonly status: ExecutionHistoryStatus;
  /** When it started and, once it ended, when it ended (ISO 8601, the application's `Clock`). */
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Where it started and with what (its start's input). */
  readonly start: ComponentRecord;
  readonly input: unknown;
  /** Where it finished and with what; none unless it finished. */
  readonly finish?: ComponentRecord;
  readonly output?: unknown;
  /** Its context values — a field marked `sensitive` hidden. */
  readonly contexts: ExecutionContextRecord;
  /** What failed or cancelled it; none otherwise. */
  readonly error?: ErrorRecord;
  /**
   * Its tree's rows of the lease log (#501) when the record was saved, oldest first: who took its
   * lease over and which of its steps were handed over. None in a record saved before #501.
   */
  readonly leaseEvents?: readonly ExecutionLeaseEventRecord[];
  /**
   * Every call its tree made that left the system (#505), in the order recorded, masked like the
   * record — so `agboss records export` carries them. None in a record saved before #505.
   */
  readonly outboundCalls?: readonly OutboundCallRecord[];
}

/** A page of a listing: `limit` records after the first `offset`, oldest start first. */
export interface ExecutionHistoryPage {
  readonly offset: number;
  readonly limit: number;
}

export abstract class ExecutionHistoryRepository {
  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /** Saves a record, replacing the one of its tenant and execution. */
  abstract save(record: ExecutionHistoryRecord): Promise<void>;

  /** The record of one execution of a tenant; `undefined` when none is kept. */
  abstract findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<ExecutionHistoryRecord | undefined>;

  /** The records of one execution id, whatever its tenant (an operator's lookup, `agboss generate`). */
  abstract findAllByExecutionId(executionId: string): Promise<ExecutionHistoryRecord[]>;

  /** The records of a thread — its turns —, oldest start first. */
  abstract findAllByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<ExecutionHistoryRecord[]>;

  /** One tenant's records started in `[from, to)`, oldest first, a page of them. */
  abstract findAllByTenantIdAndStartedAtBetween(
    tenantId: string,
    from: Date,
    to: Date,
    page: ExecutionHistoryPage,
  ): Promise<ExecutionHistoryRecord[]>;

  /** Every tenant's records started in `[from, to)`, oldest first, a page of them. */
  abstract findAllByStartedAtBetween(
    from: Date,
    to: Date,
    page: ExecutionHistoryPage,
  ): Promise<ExecutionHistoryRecord[]>;

  /** Removes every record that ended before `cutoff` (the recovery sweep, `now - retention`). */
  abstract deleteByEndedAtBefore(cutoff: Date): Promise<void>;
}

/** The row key of a record (`\u0000` never occurs in an id). */
export const historyKeyOf = (tenantId: string, executionId: string): string =>
  `${tenantId}\u0000${executionId}`;

/** Oldest start first; one start: by execution id. */
const byStart = (left: ExecutionHistoryRecord, right: ExecutionHistoryRecord): number =>
  left.startedAt.localeCompare(right.startedAt) ||
  left.executionId.localeCompare(right.executionId);

/** Whether a record started in `[from, to)`. */
const startedBetween = (record: ExecutionHistoryRecord, from: Date, to: Date): boolean => {
  const at = Date.parse(record.startedAt);
  return at >= from.getTime() && at < to.getTime();
};

/** The built-in default: the records in this instance's memory, a copy of each. */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class InMemoryExecutionHistoryRepository extends ExecutionHistoryRepository {
  constructor(private readonly database: InMemoryDatabase) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  save(record: ExecutionHistoryRecord): Promise<void> {
    const key = historyKeyOf(record.tenantId, record.executionId);
    this.database.executionHistory.set(key, structuredClone(record));
    return Promise.resolve();
  }

  findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<ExecutionHistoryRecord | undefined> {
    const record = this.database.executionHistory.get(historyKeyOf(tenantId, executionId));
    return Promise.resolve(record === undefined ? undefined : structuredClone(record));
  }

  findAllByExecutionId(executionId: string): Promise<ExecutionHistoryRecord[]> {
    return this.#where((record) => record.executionId === executionId);
  }

  findAllByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<ExecutionHistoryRecord[]> {
    return this.#where((record) => record.tenantId === tenantId && record.threadId === threadId);
  }

  async findAllByTenantIdAndStartedAtBetween(
    tenantId: string,
    from: Date,
    to: Date,
    page: ExecutionHistoryPage,
  ): Promise<ExecutionHistoryRecord[]> {
    const found = await this.#where(
      (record) => record.tenantId === tenantId && startedBetween(record, from, to),
    );
    return found.slice(page.offset, page.offset + page.limit);
  }

  async findAllByStartedAtBetween(
    from: Date,
    to: Date,
    page: ExecutionHistoryPage,
  ): Promise<ExecutionHistoryRecord[]> {
    const found = await this.#where((record) => startedBetween(record, from, to));
    return found.slice(page.offset, page.offset + page.limit);
  }

  deleteByEndedAtBefore(cutoff: Date): Promise<void> {
    for (const [key, record] of this.database.executionHistory)
      if (record.endedAt !== undefined && Date.parse(record.endedAt) < cutoff.getTime())
        this.database.executionHistory.delete(key);
    return Promise.resolve();
  }

  /** The records that match, oldest start first, copies. */
  #where(matches: (record: ExecutionHistoryRecord) => boolean): Promise<ExecutionHistoryRecord[]> {
    const found = [...this.database.executionHistory.values()].filter(matches).sort(byStart);
    return Promise.resolve(found.map((record) => structuredClone(record)));
  }
}
