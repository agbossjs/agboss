import {
  Clock,
  Injectable,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  StoreClock,
  ApplicationContext,
  type ExecutionTree,
  type ExecutionTreeValue,
} from "../../src/index.js";
import { CANCEL_REQUEST_KEY } from "../../src/app/cancel-requests.js";
import type { ExecutionIdentity } from "../../src/infrastructure/execution-lease.repository.js";
import {
  PauseStatus,
  type PauseAnswer,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";

/**
 * #811 AC4 — deliberately broken SQLite stores the A2A fault scenarios must catch:
 *
 * - `KeepingAgainSqliteExecutionLeaseRepository`: `claimExecutionId` says "kept" to an id
 *   kept before — the read repair's fence no longer fences, and the thawed start runs under the id
 *   of a task already settled start-lost (scenarios 17, 17b);
 * - `CancelBlindSqliteExecutionTreeRepository`: a tree store that never reads a tree's cancel
 *   request back — the thawed start of 17b runs past it, and neither 18's running pass nor 18c's
 *   resumed tree is ever stopped;
 * - `KeptRunSqlitePausedExecutionRepository`: a pause store that never drops a paused run — the run
 *   a cancel ended stays there;
 * - `StalePausesSqlitePausedExecutionRepository`: that store, whose read takes a pause a cancel
 *   withdrew for still waiting and whose resolve says yes to it — every fence of 18b broken (the
 *   resume's re-read before its mark, #850, too), the resume after the cancel runs.
 */

@Injectable({ deps: [SqliteConnection, StoreClock, ApplicationContext] })
export class KeepingAgainSqliteExecutionLeaseRepository extends SqliteExecutionLeaseRepository {
  override async claimExecutionId(identity: ExecutionIdentity): Promise<boolean> {
    await super.claimExecutionId(identity);
    return true;
  }
}

@Injectable({ deps: [SqliteConnection] })
export class CancelBlindSqliteExecutionTreeRepository extends SqliteExecutionTreeRepository {
  override findByIdInTree(
    tree: ExecutionTree,
    key: string,
  ): Promise<ExecutionTreeValue | undefined> {
    if (key === CANCEL_REQUEST_KEY) return Promise.resolve(undefined);
    return super.findByIdInTree(tree, key);
  }
}

@Injectable({ deps: [SqliteConnection, Clock] })
export class KeptRunSqlitePausedExecutionRepository extends SqlitePausedExecutionRepository {
  override deleteByTenantIdAndThreadId(_tenantId: string, _threadId: string): Promise<void> {
    return Promise.resolve();
  }
}

@Injectable({ deps: [SqliteConnection, Clock] })
export class StalePausesSqlitePausedExecutionRepository extends KeptRunSqlitePausedExecutionRepository {
  override async findByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
  ): Promise<PauseRecord | undefined> {
    const found = await super.findByTenantIdAndPauseId(tenantId, pauseId);
    // a pause a cancel withdrew read as still waiting: the resume's re-read before its mark passes
    return found?.status === PauseStatus.Cancelled
      ? { ...found, status: PauseStatus.Pending }
      : found;
  }

  override async resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<PauseRecord | undefined> {
    const resolved = await super.resolveByTenantIdAndPauseId(tenantId, pauseId, answer, at);
    if (resolved !== undefined) return resolved;
    // a pause no longer pending answered as if it were: the resume is told it won
    const found = await this.findByTenantIdAndPauseId(tenantId, pauseId);
    return found === undefined ? undefined : { ...found, status: PauseStatus.Resolved };
  }
}
