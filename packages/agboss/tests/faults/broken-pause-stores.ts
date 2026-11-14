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
  NO_RECIPIENTS,
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseRecipients,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import type { PauseNoticeClaim } from "../../src/infrastructure/pause-notices.js";
import { resolveChange } from "../../src/infrastructure/pause-transitions.js";
import { SqlitePauseNoticeRows } from "../../src/infrastructure/sqlite/sqlite-pause-notice-rows.js";
import type { Milliseconds } from "../../src/units/index.js";

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
    const isMark = expected === ExecutionRecordStatus.Paused && outcome.status === "running";
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

/**
 * #940 AC3 — `OutsideCloseSqlitePausedExecutionRepository`: a pause store that writes the notice of
 * an answer in a transaction of its own, a moment after the answer's — not in the answer's. A pod
 * killed in between leaves a pause answered and told to nobody: the notice is lost for good.
 */
@Injectable({ deps: [SqliteConnection, Clock] })
export class OutsideCloseSqlitePausedExecutionRepository extends SqlitePausedExecutionRepository {
  readonly #connection: SqliteConnection;

  constructor(connection: SqliteConnection, clock: Clock) {
    super(connection, clock);
    this.#connection = connection;
  }

  override async resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const before = await this.findByTenantIdAndPauseId(tenantId, pauseId);
    const planned =
      before === undefined ? undefined : resolveChange(before, answer, at, recipients);
    const resolved = await super.resolveByTenantIdAndPauseId(
      tenantId,
      pauseId,
      answer,
      at,
      NO_RECIPIENTS,
    );
    if (resolved === undefined || planned === undefined) return resolved;
    const connection = this.#connection;
    setTimeout(() => {
      try {
        connection.transaction(() => {
          new SqlitePauseNoticeRows(connection.database).append(resolved, planned.notices);
        });
      } catch {
        // the instance stopped first: its notice is lost, as when it dies
      }
    }, 3000);
    return resolved;
  }
}

/**
 * #940 AC3 — `AckedBeforeDeliverySqlitePausedExecutionRepository`: a pause store that acknowledges
 * the head notice of every mailbox it claims, before the receiver was told. A pod killed after its
 * claim leaves the notice acknowledged and delivered to nobody: lost for good.
 */
@Injectable({ deps: [SqliteConnection, Clock] })
export class AckedBeforeDeliverySqlitePausedExecutionRepository extends SqlitePausedExecutionRepository {
  override async claimNoticesDue(
    at: Date,
    limit: number,
    claimFor: Milliseconds,
    recipients: readonly string[],
  ): Promise<readonly PauseNoticeClaim[]> {
    const claims = await super.claimNoticesDue(at, limit, claimFor, recipients);
    for (const claim of claims) await super.ackNotice(claim, at);
    return claims;
  }
}
