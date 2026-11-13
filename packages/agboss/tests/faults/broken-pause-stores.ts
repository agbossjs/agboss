import {
  Clock,
  ExecutionRecordStatus,
  IdGenerator,
  Injectable,
  SqliteConnection,
  SqliteExecutionRecordRepository,
  SqlitePausedExecutionRepository,
  ApplicationContext,
  type TurnOutcome,
} from "../../src/index.js";
import {
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";

/**
 * #959 AC3 — deliberately broken SQLite stores the pause scenarios (19, 19b, 19c) must catch:
 *
 * - `ForgetfulMarkSqliteExecutionRecordRepository`: a record store whose compare-and-set of a
 *   resting root `paused → running` says yes and writes nothing — a resume that dies once it
 *   recorded its answer leaves a `paused` root with a `Resolved` pause, which recovery (it lists
 *   only `running` roots) never continues (#850's stuck tree, as a store's fault);
 * - `LostAnswerSqlitePausedExecutionRepository`: a pause store whose resolve says "resolved" and
 *   stores nothing — a pod that dies after its resume's answer leaves the pause `Pending`, the
 *   answer lost: recovery rests the tree at its pause again and nobody is asked a second time;
 * - `LostRunSqlitePausedExecutionRepository`: a pause store that never keeps a paused run — a pod
 *   killed while its tree is paused leaves nothing for a resume on another pod to continue.
 */

@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext, IdGenerator] })
export class ForgetfulMarkSqliteExecutionRecordRepository extends SqliteExecutionRecordRepository {
  override completeIfStatus(
    turnId: string,
    expected: ExecutionRecordStatus,
    outcome: TurnOutcome,
  ): Promise<boolean> {
    const isMark =
      expected === ExecutionRecordStatus.Paused && outcome.status === ExecutionRecordStatus.Running;
    return isMark ? Promise.resolve(true) : super.completeIfStatus(turnId, expected, outcome);
  }
}

@Injectable({ deps: [SqliteConnection, Clock] })
export class LostAnswerSqlitePausedExecutionRepository extends SqlitePausedExecutionRepository {
  override async resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<PauseRecord | undefined> {
    const found = await this.findByTenantIdAndPauseId(tenantId, pauseId);
    if (found?.status !== PauseStatus.Pending) return undefined;
    return {
      ...found,
      status: PauseStatus.Resolved,
      resolution: PauseResolution.Replied,
      answer,
      resolvedAt: at.toISOString(),
    };
  }
}

/** A pause store that never keeps the resting run: nothing a paused tree needs to be resumed survives. */
@Injectable({ deps: [SqliteConnection, Clock] })
export class LostRunSqlitePausedExecutionRepository extends SqlitePausedExecutionRepository {
  override save(): Promise<void> {
    return Promise.resolve();
  }
}
