import type { PausedExecution } from "../app/paused-runs.js";
import type {
  PauseFilter,
  PauseNoticeClaim,
  PauseNoticeCounts,
  PauseNoticeFacts,
  PauseNoticeKind,
  PausePage,
  PauseRecipients,
  PauseExtension,
  SetAsideMailbox,
} from "./pause-notices.js";
import type {
  PauseAnswer,
  PauseCancellation,
  PauseExpiry,
  PauseRecord,
  PauseUntakenResolution,
} from "./pause-record.js";
import type { Milliseconds } from "../units/index.js";

export {
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseCancellation,
  type PauseExpiry,
  type PauseRecord,
  type PauseUntakenResolution,
} from "./pause-record.js";

/**
 * Infrastructure (#261 S28, #265, #267 S35): the application's paused executions and their pauses.
 *
 * - **The paused tree, by thread** (tenant + thread): the run as it rested and the workflow
 *   version / config hash it paused under (checked on resume).
 * - **Its pauses, by id**: one record per waiting step (its `step.idempotencyKey`), made before
 *   the channel is asked; a resume finds it by `(tenantId, pauseId)` anywhere in the tree and turns
 *   it from `Pending` to `Resolved` with its decision, atomically — of two concurrent resumes of
 *   one pause exactly one does (Q58). A resolved record (`Taken`, `Cancelled`) is kept for
 *   `@Application({ retention: { pauseRecords } })` after it was resolved — a late answer gets
 *   `NotPausedError` — then removed by the recovery sweep (`deleteByResolvedAtBefore`, #267 S107).
 * - **Its deadline** (#910): a resume is refused at or after `expiresAt` in the same atomic step
 *   that would record it, and the closers say how a pause ended (`expire`, `cancel`, `closeUntaken`).
 * - **Its notices** (#910): every change someone must hear of writes its notices — one ordered
 *   mailbox per pause and receiver — in the same transaction as the change; they are claimed,
 *   acknowledged, retried and set aside atomically (`claimNoticesDue` and its siblings).
 *
 * One per application, listed only in `@Application({ providers })`; the built-in default is in
 * memory. A pause survives a restart only when this repository and the checkpointer
 * (`BaseCheckpointSaver`) are both durable. Your own `extends PausedExecutionRepository`.
 */
export abstract class PausedExecutionRepository {
  /**
   * Whether the store answers (#300): resolves when it is reachable, rejects with why not. One fast
   * round trip (`SELECT 1`, a `PING`), never a scan — `app.checkReadiness()` calls it under a
   * timeout of its own.
   */
  abstract ping(): Promise<void>;
  /** The execution paused on the tenant's thread; `undefined` when none waits there. */
  abstract findByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<PausedExecution | undefined>;

  /** Keeps a paused execution (one per thread of its `run.tenantId`: a later pause replaces it). */
  abstract save(paused: PausedExecution): Promise<void>;

  /** Forgets the thread's paused execution (it was resumed to its end, or cancelled). */
  abstract deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void>;

  /**
   * Atomic: the pause of `pause.stepKey` in its tenant's tree (`pause.rootExecutionId`) when one
   * exists, else `pause` saved and returned — so a step re-entered (a resume of a sibling, a retry
   * after a crash) keeps its id. A pause of the same step key in another tree is never found (#663):
   * a step key names no tree, so an execution id kept from nowhere and minted again would otherwise
   * take that tree's decision without asking — that step gets a pause of its own. The deadline
   * (`expiresAt`, `expiryBound`, `boundAt`), the reminder (`remindAt`) and the `channel` are kept as
   * written.
   */
  abstract findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord>;

  /** The tenant's pause of that id; `undefined` when the tenant has none (another tenant's too). */
  abstract findByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
  ): Promise<PauseRecord | undefined>;

  /** Every pause of the tree, whatever its status. */
  abstract findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly PauseRecord[]>;

  /**
   * Atomic: marks the pause's channel asked, whatever its status (a closed one too — a fast reply
   * or a cancel may have closed it while `send` was returning). Only when `isSent` was false, and
   * in one transaction with it, writes in this order: `opened` (with `expiresAt`) to the listeners;
   * when the pause is no longer `Pending`, its `closed` (reason and time by `pauseClosedReasonOf` /
   * `closedAtOf`) to the channel and the listeners — a cancel during `send` must still take the
   * channel's buttons off; when it is a closed-untaken one (`Cancelled` with an answer), its
   * `answerNotTaken` to the same. Returns whether the pause is still `Pending`. Serves I7, I8.
   */
  abstract markSentByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    recipients: PauseRecipients,
  ): Promise<boolean>;

  /**
   * Atomic: turns the pause from `Pending` to `Resolved` with `answer` (`Replied`, resolved `at`)
   * **only while `expiresAt` is absent or after `at`** — in the one step that records it, so no
   * answer is ever recorded at or after the deadline, whatever the sweep did yet (I1, I2) — and
   * returns it; `undefined` when the pause is not pending, past its deadline, or none. A sent
   * pause's `closed` (`Answered`) goes in the same transaction to the channel and the listeners (I7).
   */
  abstract resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined>;

  /**
   * Atomic: its channel decided at once (`ChannelOutcome.decided`) — the pause goes from `Pending`
   * to `Taken` with `answer` (`PauseResolution.Decided`); `false` when it was not pending. The
   * pause was never sent: no notice (I8).
   */
  abstract decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<boolean>;

  /**
   * Atomic: turns the pause from `Pending` to `Cancelled` — `Withdrawn` (a `FailFast` sibling
   * failed, a quorum was decided: whatever the time), `Cancelled` (`app.cancel`) or `TreeEnded`;
   * the last two at or after `expiresAt` record `Expired` instead (I3). Returns the closed record,
   * `undefined` when it was not pending. A sent pause's `closed` goes in the same transaction (I7).
   */
  abstract cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined>;

  /**
   * Atomic: the pause's deadline passed — only while `Pending` and `expiresAt ≤ at`. With
   * `expiry.answer` it becomes `Resolved`, `DecidedOnExpiry`, the answer kept (`answeredBy`
   * `undefined`); otherwise `Cancelled`, `Expired`, with `expiry.problem` kept when given.
   * `resolvedAt = at`. Returns the record, `undefined` when it does not apply. A sent pause's
   * `closed` (`Expired`) goes in the same transaction (I1, I7).
   */
  abstract expireByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    expiry: PauseExpiry,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined>;

  /**
   * Atomic: closes an answer no step took — only while `Resolved`: `Cancelled` with `resolution`
   * (`Cancelled` or `TreeEnded`), the answer kept, `resolvedAt = at`. A sent pause's
   * `answerNotTaken` goes to the channel and the listeners in the same transaction, after the
   * `closed` written at its resolve (I8, Q2). Returns the record, `undefined` when it does not apply.
   */
  abstract closeUntakenByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseUntakenResolution,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined>;

  /**
   * Atomic: moves the deadline — only while `Pending`, `expiresAt` set and after `at`, and
   * `change.expiresAt` after `at` (never to a past time). Sets `expiresAt`, `expiryBound = Pause`
   * and `remindAt` as given and writes `extended` (`expiresAt`, `previousExpiresAt`) in the same
   * transaction. Returns the record, `undefined` when it does not apply (I3, I7).
   */
  abstract extendByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    change: PauseExtension,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined>;

  /**
   * Atomic, once: the reminder of a `Pending` pause with `remindAt ≤ at < expiresAt` — clears
   * `remindAt` and writes `expiring` (`expiresAt`) in the same transaction. `false` when it does
   * not apply, the second call included (I7).
   */
  abstract remindByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean>;

  /**
   * Atomic, idempotent: appends a notice of `kind` with `facts` (and `writtenAt = at`) to the
   * pause's mailboxes **unless the pause already has a notice of that kind** — so a pass re-run
   * after a crash writes it once — in any status, **but only when the pause `isSent`** (a pause its
   * channel decided at once never got `opened`, so it gets no `joinFailed` either, I8). Only
   * `JoinFailed` uses it (#945). Returns whether it wrote.
   */
  abstract noticeOnceByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    kind: PauseNoticeKind,
    facts: PauseNoticeFacts,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean>;

  /** Turns a `Resolved` pause to `Taken`: its step took the decision (the pass that ran it returned). */
  abstract markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void>;

  /** The pause of the step key in the tenant's tree (the unique key), one indexed read; `undefined` when none. */
  abstract findByTenantIdAndRootExecutionIdAndStepKey(
    tenantId: string,
    rootExecutionId: string,
    stepKey: string,
  ): Promise<PauseRecord | undefined>;

  /**
   * Every tenant's `Pending` pauses with `expiresAt ≤ at`, ascending by `(expiresAt, tenantId,
   * pauseId)`, at most `limit` (1 to 1000; else `RangeError`).
   */
  abstract findPendingByExpiresAtBefore(at: Date, limit: number): Promise<readonly PauseRecord[]>;

  /** The same on `remindAt`: `Pending` pauses with `remindAt ≤ at`, ascending by `(remindAt, tenantId, pauseId)`. */
  abstract findPendingByRemindAtBefore(at: Date, limit: number): Promise<readonly PauseRecord[]>;

  /**
   * Every tenant's open pauses (`Pending` or `Resolved`) in the store's stable insertion order,
   * `limit` per page (1 to 1000); `after` is the `next` of the page before (an opaque cursor over
   * the monotonic insertion sequence, so a removal between two pages skips nothing). The orphan look.
   */
  abstract findOpenAfter(after: string | undefined, limit: number): Promise<PausePage>;

  /**
   * One tenant's pauses that `filter` selects (statuses, channel, `expiresBefore`), in the store's
   * insertion order, `limit` per page, `after` as `findOpenAfter`'s. Never another tenant's.
   */
  abstract findPageByTenantId(
    tenantId: string,
    filter: PauseFilter,
    limit: number,
    after?: string,
  ): Promise<PausePage>;

  /** What `deleteByResolvedAtBefore(cutoff)` would remove, at most `limit` (the retention's log repair, I11). */
  abstract findClosedByResolvedAtBefore(
    cutoff: Date,
    limit: number,
  ): Promise<readonly PauseRecord[]>;

  /**
   * Removes every `Taken` and `Cancelled` pause of every tenant resolved before `cutoff` (the
   * recovery sweep, `now - retention.pauseRecords`); `Pending` and `Resolved` ones are never
   * removed, and neither is one with a mailbox that is neither fully delivered nor dead (I11). The
   * mailboxes of a removed pause go with it.
   */
  abstract deleteByResolvedAtBefore(cutoff: Date): Promise<void>;

  /**
   * Claims up to `limit` mailboxes for delivery, ascending by `nextAttemptAt`: of a recipient among
   * `recipients` (`"channel:<name>"` / `"listener:<name>"`), not dead, with undelivered notices,
   * `nextAttemptAt ≤ at`, unclaimed or with an expired claim — each under a fresh random token
   * until `at + claimFor`. A claim holds one mailbox, so a stuck head never holds another (I9).
   */
  abstract claimNoticesDue(
    at: Date,
    limit: number,
    claimFor: Milliseconds,
    recipients: readonly string[],
  ): Promise<readonly PauseNoticeClaim[]>;

  /**
   * Acknowledges the claim's head notice — only when the token is the mailbox's and `until > at`
   * (a zombie's late ack changes nothing): `delivered + 1`, `attempts = 0`, the next notice is the
   * head and due at once. Returns the same claim over the updated mailbox while notices remain,
   * else `undefined` (the claim released; also when the token was lost).
   */
  abstract ackNotice(claim: PauseNoticeClaim, at: Date): Promise<PauseNoticeClaim | undefined>;

  /**
   * A failed attempt — only for the mailbox's token: `attempts + 1`, due at `nextAttemptAt`, the
   * last failure's fixed `problem` code (never a message), the claim released. `false` when the
   * token was lost.
   */
  abstract retryNotice(
    claim: PauseNoticeClaim,
    nextAttemptAt: Date,
    problem: string,
  ): Promise<boolean>;

  /** Gives the mailbox up — only for its token: dead, never claimed again (I10). `false` when the token was lost. */
  abstract setAsideNotices(claim: PauseNoticeClaim, at: Date, problem: string): Promise<boolean>;

  /**
   * Sets aside, at most `limit`, every live mailbox — not dead, with undelivered notices, unclaimed
   * or with a claim over at `at` — whose head notice was written before `writtenBefore` (the
   * retention look: the one way a mailbox of a receiver no instance knows ends, I11). Returns them
   * for the log.
   */
  abstract setAsideStaleNoticesBefore(
    writtenBefore: Date,
    at: Date,
    problem: string,
    limit: number,
  ): Promise<readonly SetAsideMailbox[]>;

  /** How many mailboxes wait for delivery (not dead, undelivered) and how many were set aside. */
  abstract countNotices(): Promise<PauseNoticeCounts>;

  /**
   * Removes the thread's paused run only when its run is `runId` — one statement, so another
   * run's paused run, saved since, is never removed (I13).
   */
  abstract deleteByTenantIdAndThreadIdAndRunId(
    tenantId: string,
    threadId: string,
    runId: string,
  ): Promise<void>;
}
