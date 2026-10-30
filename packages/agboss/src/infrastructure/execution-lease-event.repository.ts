import { Injectable } from "../components/decorators.js";
import { IN_MEMORY_DATABASE } from "./instance-tokens.js";
import type { InMemoryDatabase } from "./in-memory-database.js";
import type { OutboundCallStatus } from "./outbound-call.repository.js";

/**
 * Infrastructure (#501): the lease log — an append-only record of what happened to the leases of an
 * application's execution trees: who took a tree's lease over (`Takeover`) and which step stopped
 * because it lost it (`HandedOver`). Identities and tokens only, never a payload; masked like
 * observer events. Always written, whatever `executionRecordRetention` says, before the observers
 * hear of it, and readable while the tree runs (`app.leaseEventsOf`); the recovery sweep removes the
 * rows older than `@Application({ leaseEventRetention })` (default `hours(24)`). Listed only in
 * `@Application({ providers })`; the built-in default is in memory, `SqliteExecutionLeaseEventRepository`
 * keeps it in the application's SQLite file.
 */

/** What a row of the lease log records. */
export enum ExecutionLeaseEventKind {
  /** An instance took a tree's lease over (`onExecutionLeaseTakeover`). */
  Takeover = "takeover",
  /** A step stopped without failing: its lease was lost or fenced, or the app stopped (`onStepHandedOver`). */
  HandedOver = "handed-over",
  /** A step's fenced effect (#500) ran, was replayed, joined or was refused (`onFencedEffect`). */
  FencedEffect = "fenced-effect",
  /** A step's call that leaves the system (#505) moved: recorded, sent, reconciled… (`onOutboundCall`). */
  OutboundCall = "outbound-call",
}

/** What happened to a call that leaves the system (#505), as the lease log keeps it. */
export enum OutboundCallEventOutcome {
  /** Its intent was recorded, before anything was sent. */
  Recorded = "recorded",
  /** It was sent and answered: its result stored. */
  Sent = "sent",
  /** It was completed before: its stored result came back, nothing sent. */
  Replayed = "replayed",
  /** Left pending, `reconcile` found that it happened: its result stored, nothing sent. */
  Reconciled = "reconciled",
  /** Left pending, `reconcile` found that it never arrived: it goes out again, the same key. */
  NotSent = "not-sent",
  /** Left pending, nobody could say what happened: the step fails, the intent stays pending. */
  Unknown = "unknown",
  /** The other system answered with an error: the intent is failed. */
  Failed = "failed",
}

/** How one call of a fenced effect (#500) went, as the lease log keeps it. */
export enum FencedEffectEventOutcome {
  /** The write ran now (`FencedEffectStatus.Ran`). */
  Ran = "ran",
  /** The stored result came back, the write did not run again (`FencedEffectStatus.Replayed`). */
  Replayed = "replayed",
  /** The call joined one in flight on the same key (`FencedEffectStatus.Joined`). */
  Joined = "joined",
  /** The lease or the scope's mark refused the call (`ExecutionFencedError`): nothing written. */
  Refused = "refused",
}

/** What the instance that took a tree's lease over does with the tree. */
export enum LeaseTakeoverReason {
  /** The recovery sweep continues it from its last checkpoint. */
  Recovered = "recovered",
  /** A resume moves it with an answer. */
  Resumed = "resumed",
  /** A cancel ends it. */
  Cancelled = "cancelled",
  /** The recovery sweep finishes its automatic undo (#340 PR 4). */
  Unwinding = "unwinding",
  /** A worker runs or reclaims a `ChildPlacement.AnyInstance` child under its own lease (#333). */
  RemoteChild = "remote-child",
  /** Its holder took its yielded lease back after waiting for remote children, at a new token. */
  Reacquired = "reacquired",
}

/** Why a step was handed over. */
export enum HandOverReason {
  /** Its lease expired or another instance took it (`ExecutionLeaseLostError`). */
  LeaseLost = "lease-lost",
  /** An external system refused one of its writes (`ExecutionFencedError`, #471). */
  Fenced = "fenced",
  /** The instance stopped past its shutdown timeout (`ApplicationStoppingError`). */
  ApplicationStopping = "application-stopping",
}

/** Where the hand-over was found first: the innermost part of the step that stopped. */
export enum HandOverSite {
  /** The step's own code (an action, a router, an agent's model call). */
  Step = "step",
  /** A tool call. */
  Tool = "tool",
  /** A tool interceptor (#384). */
  ToolInterceptor = "tool-interceptor",
  /** An automatic undo action (#340). */
  Compensation = "compensation",
  /** A branch of a parallel launch (#273). */
  Branch = "branch",
  /** A child workflow's step in its parent (#263). */
  Child = "child",
}

/** The step a row is about: its join keys. */
export interface LeaseEventStep {
  readonly nodeId: string;
  readonly visitNumber: number;
  readonly idempotencyKey: string;
}

/** What every row carries: when, which tree and execution, and the lease. */
export interface ExecutionLeaseEventBase {
  readonly kind: ExecutionLeaseEventKind;
  /** When it happened (ISO 8601, the application's `Clock`). */
  readonly occurredAt: string;
  readonly tenantId: string;
  /** The tree's root: what `app.leaseEventsOf` finds the row by. */
  readonly rootExecutionId: string;
  /** The execution whose lease was taken over, or whose step was handed over. */
  readonly executionId: string;
  /** The lease scope (`executionContext.fence.scopeKey`). */
  readonly scopeKey: string;
  /** The lease's token: the new holder's for a takeover, the stopped holder's for a hand-over. */
  readonly token: number;
  /** The instance that took the lease over, or whose step was handed over. */
  readonly holderInstanceId: string;
}

/** A takeover of a tree's lease (`ExecutionLeaseEventKind.Takeover`). */
export interface LeaseTakeoverRecord extends ExecutionLeaseEventBase {
  readonly kind: ExecutionLeaseEventKind.Takeover;
  readonly reason: LeaseTakeoverReason;
  /** The holder whose lease had expired (the store's `takenOverFrom`), when the store names it. */
  readonly previousHolderInstanceId?: string;
  readonly previousToken?: number;
  /** The tree's head checkpoint when the lease was taken, where the take reads it. */
  readonly checkpointId?: string;
}

/** A step handed over (`ExecutionLeaseEventKind.HandedOver`). */
export interface StepHandedOverRecord extends ExecutionLeaseEventBase {
  readonly kind: ExecutionLeaseEventKind.HandedOver;
  readonly reason: HandOverReason;
  readonly site: HandOverSite;
  readonly step: LeaseEventStep;
  /** The newer token the external system saw, when it said (a fenced write). */
  readonly observedToken?: number;
}

/** One call of a step's fenced effect (`ExecutionLeaseEventKind.FencedEffect`), never its result. */
export interface FencedEffectRecord extends ExecutionLeaseEventBase {
  readonly kind: ExecutionLeaseEventKind.FencedEffect;
  /** The effect's name (`fencedEffectKeyOf(executionContext, name)`). */
  readonly name: string;
  readonly outcome: FencedEffectEventOutcome;
  readonly step: LeaseEventStep;
  /** The token the stored result was first written under (a replay on a newer lease: the older). */
  readonly writtenToken?: number;
  /** The newer token the store saw, when it refused the call. */
  readonly observedToken?: number;
}

/**
 * One move of a step's call that leaves the system (`ExecutionLeaseEventKind.OutboundCall`, #505):
 * never its request or its result.
 */
export interface OutboundCallEventRecord extends ExecutionLeaseEventBase {
  readonly kind: ExecutionLeaseEventKind.OutboundCall;
  /** The call's name (`fencedEffectKeyOf(executionContext, name)`). */
  readonly name: string;
  readonly target: string;
  readonly operation: string;
  /** The intent's state after the move. */
  readonly status: OutboundCallStatus;
  readonly attempt: number;
  readonly outcome: OutboundCallEventOutcome;
  readonly step: LeaseEventStep;
}

/** One row of the lease log. */
export type ExecutionLeaseEventRecord =
  | LeaseTakeoverRecord
  | StepHandedOverRecord
  | FencedEffectRecord
  | OutboundCallEventRecord;

export abstract class ExecutionLeaseEventRepository {
  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /** Appends a row; rows are never changed. */
  abstract save(record: ExecutionLeaseEventRecord): Promise<void>;

  /** The rows of one tree of a tenant, oldest first; rows of one moment in the order saved. */
  abstract findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly ExecutionLeaseEventRecord[]>;

  /** Removes every row that happened before `cutoff` (the recovery sweep, `now - retention`). */
  abstract deleteByOccurredAtBefore(cutoff: Date): Promise<void>;
}

/** The built-in default: the rows in this instance's memory (a test's instances share them). */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class InMemoryExecutionLeaseEventRepository extends ExecutionLeaseEventRepository {
  constructor(private readonly database: InMemoryDatabase) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  save(record: ExecutionLeaseEventRecord): Promise<void> {
    this.database.executionLeaseEvents.push(structuredClone(record));
    return Promise.resolve();
  }

  findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly ExecutionLeaseEventRecord[]> {
    const found = this.database.executionLeaseEvents
      .filter((row) => row.tenantId === tenantId && row.rootExecutionId === rootExecutionId)
      // a stable sort: rows of one moment keep the order they were saved in
      .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
    return Promise.resolve(found.map((row) => structuredClone(row)));
  }

  deleteByOccurredAtBefore(cutoff: Date): Promise<void> {
    const kept = this.database.executionLeaseEvents.filter(
      (row) => Date.parse(row.occurredAt) >= cutoff.getTime(),
    );
    this.database.executionLeaseEvents.splice(0, Infinity, ...kept);
    return Promise.resolve();
  }
}
