import type { Expiry } from "./expiry.js";
import type { PausedExecutionRepository } from "./paused-execution.repository.js";
import type { PauseAnswerLog } from "./pause-answer-log.js";
import { removeClosedPauses } from "./pause-log-repair.js";
import type { MeshRequestRepository } from "./mesh-request.repository.js";
import type { FencedEffectRepository } from "./fenced-effect.repository.js";
import type { EndedTree, ExecutionAuditLogRepository } from "./execution-audit-log.repository.js";
import type { OutboundCallRepository } from "./outbound-call.repository.js";
import type { ExecutionHistoryRepository } from "./execution-history.repository.js";
import type { CostLedgerRepository } from "./cost-ledger.repository.js";
import {
  ExecutionRecordStatus,
  type ExecutionRecordRepository,
} from "./execution-record.repository.js";
import type { Clock } from "./clock.js";
import type { FrameworkLog } from "./logger.js";
import { pauseKeyOf } from "./pause-record.js";
import type { Milliseconds } from "../units/index.js";

/**
 * What every look of the recovery sweep removes once its retention is over, on the `Clock`: the
 * resolved pause records (#267 S107), the trusted mesh requests' answers (#398 PR 2), the kept
 * executions that ended (#401 PR 1), the idempotent effects' results and marks and the ended
 * outbound calls, each at its own `expires_at` (#1317), the lease log's rows (#501) and the
 * ledger's entries (#771). A store that fails is reported and asked again at the next look.
 */

/** The stores the sweep removes old rows from, and how long each keeps them. */
export interface RetentionSources {
  readonly clock: Clock;
  /** The application's pause records: the resolved ones are removed after their retention. */
  readonly pauses: PausedExecutionRepository;
  /** Where a mailbox nobody delivers is reported (`pause.notice-recipient-unknown`, #940). */
  readonly log?: FrameworkLog | undefined;
  /** Where a closed pause's answer is logged: a lost entry is written before its record goes (#939). */
  readonly answers?: PauseAnswerLog | undefined;
  /** `@Application({ retention: { pauseRecords } })`: how long a resolved pause record is kept. */
  readonly pauseRecordRetention: Milliseconds;
  /** The trusted mesh requests' answers (#398 PR 2): removed after their retention. */
  readonly meshRequests?: MeshRequestRepository | undefined;
  /** `@Application({ retention: { meshAnswers } })`: how long an answer is kept. */
  readonly idempotencyRetention?: number | undefined;
  /**
   * The kept root executions (#401 PR 1) and `@Application({ retention: { executionRecords } })`: a record
   * that ended longer ago than it is removed; none set → nothing is kept, nothing removed.
   */
  readonly executionHistory?: ExecutionHistoryRepository | undefined;
  readonly executionRecordRetention?: Milliseconds | undefined;
  /** The idempotent effects' results and marks (#500), each removed once its `expires_at` has come (#1317). */
  readonly fencedEffects?: FencedEffectRepository<unknown> | undefined;
  /**
   * The audit log (#501) and its retention (`auditLogTtl`): older rows of trees that ended are
   * removed — never a row of a live or paused tree, whose takeover reads them (#853).
   */
  readonly auditLog?: ExecutionAuditLogRepository | undefined;
  /** The root records the sweep reads to tell whether a tree ended: none, no audit row is removed. */
  readonly treeRecords?: Pick<ExecutionRecordRepository, "findByTenantIdAndRunId"> | undefined;
  readonly auditLogRetention?: Milliseconds | undefined;
  /** More kinds of rows, each with its own removal (#807: the finished A2A tasks). */
  readonly expiries?: readonly Expiry[] | undefined;
  /** The ended outbound calls (#505), each removed once its `expires_at` has come (#1317); never a pending one. */
  readonly outboundCalls?: OutboundCallRepository | undefined;
  /** The ledger (#771) and `@Application({ retention: { costLedgerEntries } })`: older entries pruned. */
  readonly ledger?: CostLedgerRepository | undefined;
  readonly ledgerEntryRetention?: Milliseconds | undefined;
}

/**
 * The retention of rows that carry their own expiry (#1317: `expires_at`): none after it — the
 * cutoff of the look is the `Clock`'s now, and the store removes what is due by then.
 */
const DUE_NOW = 0;

/** How many mailboxes of unknown receivers one look sets aside. */
const UNKNOWN_PER_LOOK = 200;

/**
 * A mailbox whose head notice is older than the retention and that no instance claims (a listener
 * a deploy removed, a rolling deploy's channel) is set aside and reported — the one way it ends:
 * then its pause goes with the retention (#940 V2, I11).
 */
async function setAsideUnknown(sources: RetentionSources, cutoff: Date): Promise<void> {
  const { pauses, clock, log } = sources;
  const asides = await pauses.setAsideStaleNoticesBefore(
    cutoff,
    clock.now(),
    "recipient-unknown",
    UNKNOWN_PER_LOOK,
  );
  for (const { tenantId, pauseId, recipient } of asides)
    log?.warn(
      "pause.notice-recipient-unknown",
      `the notices of pause ${pauseKeyOf(tenantId, pauseId)} to ${recipient} were set aside: no instance knows that receiver`,
      { tenantId },
    );
}

/** The statuses of a root record that ended (text: a record's status may be compared with them). */
const ENDED_STATUSES: readonly string[] = [
  ExecutionRecordStatus.Answered,
  ExecutionRecordStatus.Failed,
  ExecutionRecordStatus.Guarded,
  ExecutionRecordStatus.Stopped,
  ExecutionRecordStatus.Cancelled,
];

/**
 * Whether a tree ended, by its root's record. A tree with no record, a `running` or a `paused` one
 * counts as live: nothing is removed on a guess.
 */
const endedTreeOf =
  (records: Pick<ExecutionRecordRepository, "findByTenantIdAndRunId">): EndedTree =>
  async ({ tenantId, rootExecutionId }) => {
    const record = await records.findByTenantIdAndRunId(tenantId, rootExecutionId);
    return record !== undefined && ENDED_STATUSES.includes(record.status);
  };

/** The audit log's old rows of the trees that ended; with no records to tell it by, none (#1321b). */
const auditLogExpiry = ({
  auditLog,
  treeRecords,
  auditLogRetention,
}: RetentionSources): Expiry => ({
  what: "the audit log's old rows",
  remove:
    auditLog &&
    treeRecords &&
    ((cutoff) => auditLog.deleteExpired(cutoff, endedTreeOf(treeRecords))),
  retention: auditLogRetention,
});

const expiriesOf = (sources: RetentionSources): readonly Expiry[] => {
  const { pauses, meshRequests, executionHistory, fencedEffects, outboundCalls } = sources;
  return [
    {
      what: "the notices of a receiver no instance knows",
      remove: (cutoff) => setAsideUnknown(sources, cutoff),
      retention: sources.pauseRecordRetention,
    },
    {
      what: "the resolved pause records",
      remove: (cutoff) =>
        sources.answers === undefined
          ? pauses.deleteByResolvedAtBefore(cutoff)
          : removeClosedPauses(pauses, sources.answers, cutoff),
      retention: sources.pauseRecordRetention,
    },
    {
      what: "the mesh requests' answers",
      remove: meshRequests && ((cutoff) => meshRequests.deleteExpired(cutoff)),
      retention: sources.idempotencyRetention,
    },
    {
      what: "the kept execution records",
      remove: executionHistory && ((cutoff) => executionHistory.deleteExpired(cutoff)),
      retention: sources.executionRecordRetention,
    },
    {
      what: "the idempotent effects' expired results",
      remove: fencedEffects && ((now) => fencedEffects.deleteExpired(now)),
      retention: DUE_NOW,
    },
    auditLogExpiry(sources),
    {
      what: "the expired outbound calls",
      remove: outboundCalls && ((now) => outboundCalls.deleteExpired(now)),
      retention: DUE_NOW,
    },
    {
      what: "the ledger's old entries",
      remove: sources.ledger?.deleteByMadeAtBefore.bind(sources.ledger),
      retention: sources.ledgerEntryRetention,
    },
    // Stryker disable next-line ArrayDeclaration: an entry that is a string has no `remove`, and `removeExpired` skips an entry with none
    ...(sources.expiries ?? []),
  ];
};

/** What one look removed of one kind of rows: the stores that count give the number (`onTtlSweep`). */
export interface SweptRows {
  readonly what: string;
  readonly removed: number | undefined;
}

/**
 * Removes every kind of rows past its retention and tells what each look removed; `report` hears of
 * each store that failed.
 */
export async function removeExpired(
  sources: RetentionSources,
  report: (text: string) => void,
): Promise<readonly SweptRows[]> {
  const swept: SweptRows[] = [];
  for (const { what, remove, retention } of expiriesOf(sources)) {
    if (remove === undefined || retention === undefined) continue;
    try {
      const removed = await remove(new Date(sources.clock.now().getTime() - retention));
      swept.push({ what, removed: typeof removed === "number" ? removed : undefined });
    } catch (error) {
      report(`${what} could not be removed: ${String(error)}`);
    }
  }
  return swept;
}
