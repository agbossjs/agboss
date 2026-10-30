import { Injectable } from "../components/decorators.js";
import { ApplicationContext } from "../flow/context/application-context.js";
import { Clock } from "./clock.js";
import { ExecutionRecordStatus } from "./execution-record.repository.js";
import { IN_MEMORY_DATABASE } from "./in-memory-database.js";
import { treeKeyOf, type InMemoryDatabase } from "./in-memory-database.js";

/** One queued child execution, as the queue keeps it (#333 PR 2). */
export interface QueuedChildExecution {
  /** The tenant of its tree. */
  readonly tenantId: string;
  /** The child's own execution id. */
  readonly executionId: string;
  /** The root of its tree. */
  readonly rootExecutionId: string;
  /** The execution that launched it. */
  readonly parentExecutionId: string;
  /** The application's workflow whose tree it is (its root's): how a worker finds the child's graph. */
  readonly rootWorkflow: string;
  /** The child workflow's `name`. */
  readonly workflow: string;
  /** Its level in the tree, from 2: the deepest are claimed first. */
  readonly depth: number;
  /** `Queued` → `Running` (claimed) → `Paused` (waiting for an answer) or `Answered` / `Failed`. */
  readonly status: ExecutionRecordStatus;
  /** What the worker runs it with (framework data, JSON): its first state, thread and parents. */
  readonly run: string;
  /** When its parent queued it (the framework's clock). */
  readonly queuedAt: Date;
  /** The instance that claimed it (`applicationContext.instanceId`). */
  readonly instanceId?: string | undefined;
  /** When it was claimed. */
  readonly claimedAt?: Date | undefined;
  /** When it ended. */
  readonly endedAt?: Date | undefined;
  /** A failed child's error (framework data, JSON: the names, codes and messages of its chain). */
  readonly failure?: string | undefined;
}

/** How a claimed child ended its pass: finished, paused, or failed with its error. */
export interface ChildExecutionEnd {
  /** `Answered` — it reached a finish; `Paused` — it rests at a pause (#333 PR 4); `Failed`. */
  readonly status:
    ExecutionRecordStatus.Answered | ExecutionRecordStatus.Paused | ExecutionRecordStatus.Failed;
  /** A failed child's error (as `QueuedChildExecution.failure`). */
  readonly failure?: string | undefined;
}

/**
 * Infrastructure (#333 PR 2, ADR-0022): the queue of child executions launched with
 * `placement: ChildPlacement.AnyInstance`. The parent's node saves its child here and waits; any
 * instance of the application with a free step slot (#332) claims the first queued child —
 * atomically, so of two instances exactly one gets it — runs it on its own checkpoint thread and
 * completes the row; the parent's tree then goes on. Keyed by `(tenantId, executionId)`; a tree's
 * rows are removed when its root ends. Listed only in `@Application({ providers })`; the built-in
 * default is in memory (one instance claims its own children — `[application.in-memory-child-queue]`).
 * Your own `extends ChildExecutionQueueRepository`; time comes from the framework's clock.
 */
export abstract class ChildExecutionQueueRepository {
  /**
   * Whether the store answers (#300): resolves when it is reachable, rejects with why not. One fast
   * round trip, never a scan.
   */
  abstract ping(): Promise<void>;
  /** Saves a `Queued` child unless its id is already queued; `true` when this call saved it. */
  abstract saveIfAbsent(child: QueuedChildExecution): Promise<boolean>;
  /** The child by its tenant and id; `undefined` when it is not (or no longer) queued. */
  abstract findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined>;
  /**
   * Claims the first `Queued` child — the deepest first, then the longest waiting — for this
   * instance: `Running`, with its `instanceId` and `claimedAt`. Atomic: a child is claimed once.
   */
  abstract claimFirstByStatusQueuedOrderByDepthDesc(): Promise<QueuedChildExecution | undefined>;
  /**
   * Ends a child this instance claimed (`Running`, its `instanceId`); `false` when it is not this
   * instance's running child (its tree ended and its rows were removed).
   */
  abstract completeByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
    end: ChildExecutionEnd,
  ): Promise<boolean>;
  /** Removes every queued child of a tree (its root ended). */
  abstract deleteAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<void>;
}

/** The order of the claims: the deepest first, then the longest waiting. */
export const claimOrder = (left: QueuedChildExecution, right: QueuedChildExecution): number =>
  right.depth - left.depth || left.queuedAt.getTime() - right.queuedAt.getTime();

/** A `Paused` child (resumed) or a `Running` claim whose worker lost its lease may be queued again. */
const canRequeue = (stored: QueuedChildExecution, next: QueuedChildExecution): boolean =>
  stored.status === ExecutionRecordStatus.Paused ||
  (stored.status === ExecutionRecordStatus.Running &&
    next.claimedAt !== undefined &&
    stored.claimedAt?.getTime() === next.claimedAt.getTime());

/**
 * The built-in default: the queue in this instance's memory — every operation is one synchronous
 * step, so it is atomic. The instances of one test share it (`testWith(App, { instances: 2 })`).
 */
@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
export class InMemoryChildExecutionQueueRepository extends ChildExecutionQueueRepository {
  constructor(
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly database: InMemoryDatabase,
  ) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  saveIfAbsent(child: QueuedChildExecution): Promise<boolean> {
    const key = treeKeyOf(child.tenantId, child.executionId);
    const stored = this.database.childQueue.get(key);
    if (stored !== undefined && !canRequeue(stored, child)) return Promise.resolve(false);
    this.database.childQueue.set(key, {
      ...child,
      status: ExecutionRecordStatus.Queued,
      instanceId: undefined,
      claimedAt: undefined,
      endedAt: undefined,
      failure: undefined,
    });
    return Promise.resolve(true);
  }

  findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined> {
    return Promise.resolve(this.database.childQueue.get(treeKeyOf(tenantId, executionId)));
  }

  claimFirstByStatusQueuedOrderByDepthDesc(): Promise<QueuedChildExecution | undefined> {
    const [first] = [...this.database.childQueue.values()]
      .filter((child) => child.status === ExecutionRecordStatus.Queued)
      .sort(claimOrder);
    if (first === undefined) return Promise.resolve(undefined);
    const claimed: QueuedChildExecution = {
      ...first,
      status: ExecutionRecordStatus.Running,
      instanceId: this.applicationContext.instanceId,
      claimedAt: this.clock.now(),
    };
    this.database.childQueue.set(treeKeyOf(first.tenantId, first.executionId), claimed);
    return Promise.resolve(claimed);
  }

  completeByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
    end: ChildExecutionEnd,
  ): Promise<boolean> {
    const key = treeKeyOf(tenantId, executionId);
    const stored = this.database.childQueue.get(key);
    const isOwn =
      stored?.status === ExecutionRecordStatus.Running &&
      stored.instanceId === this.applicationContext.instanceId;
    if (stored === undefined || !isOwn) return Promise.resolve(false);
    this.database.childQueue.set(key, {
      ...stored,
      status: end.status,
      endedAt: this.clock.now(),
      failure: end.failure,
    });
    return Promise.resolve(true);
  }

  deleteAllByTenantIdAndRootExecutionId(tenantId: string, rootExecutionId: string): Promise<void> {
    for (const [key, child] of this.database.childQueue)
      if (child.tenantId === tenantId && child.rootExecutionId === rootExecutionId)
        this.database.childQueue.delete(key);
    return Promise.resolve();
  }
}
