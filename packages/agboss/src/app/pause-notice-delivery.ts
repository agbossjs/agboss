import type { FrameworkLog } from "../infrastructure/logger.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import type { PauseNoticeClaim } from "../infrastructure/pause-notices.js";
import { pauseKeyOf, type PauseRecord } from "../infrastructure/pause-record.js";
import { waitOf } from "../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../units/index.js";
import type { AppDeps } from "./app-deps.js";
import { NoticeTimeoutError } from "./pause-notice-call.js";
import { receive, UnknownReceiverError, type ReceiveParts } from "./pause-notice-receive.js";

/**
 * The delivery of pause notices (#940, #910 I7–I10): every look claims the mailboxes due — one per
 * pause and receiver, so a stuck head never holds another — and tells each its head notice, in the
 * order written, acknowledging it once the receiver returned: a crash anywhere before the ack
 * delivers it again, with the same `deliveryId` (at least once, never zero times). A receiver that
 * throws or runs past its timeout gets the notice again after a growing pause (1 s × 2^attempts, at
 * most 5 min); when the head is older than `retention.pauseRecords` the mailbox is set aside, logged
 * as an error. Loaded with the first notice (`application/pause-timers.ts` runs the look).
 */

/** The most mailboxes one look claims. */
const CLAIMS_PER_LOOK = 50;
/** How long a claim holds its mailbox: one look's work on it. */
const CLAIM_FOR: Milliseconds = seconds(60);
/** The longest pause between two attempts. */
const MAX_BACKOFF: Milliseconds = seconds(300);

/** What the delivery works with. */
export interface DeliveryParts extends ReceiveParts {
  readonly pauses: PausedExecutionRepository;
  readonly log: FrameworkLog;
  /** `retention.pauseRecords`: how long a head notice is retried before the mailbox is set aside. */
  readonly retention: Milliseconds;
  /** This instance's receivers: every `channel:<name>` and `listener:<name>` it knows. */
  readonly recipients: () => readonly string[];
  /** The root workflow's deps of a pause (its tree's checkpoint, its frame); `undefined`: none. */
  readonly rootOf: (pause: PauseRecord) => Promise<AppDeps | undefined>;
}

/** A pause the delivery cannot read (removed, or of no workflow of this instance). */
class PauseUnreadableError extends Error {
  override name = "PauseUnreadableError";
}

/** A fixed code of what went wrong, never a message (a message may carry a receiver's secrets). */
function problemOf(error: unknown): string {
  if (error instanceof NoticeTimeoutError) return "receiver-timeout";
  if (error instanceof UnknownReceiverError) return "receiver-unknown";
  if (error instanceof PauseUnreadableError) return "pause-unreadable";
  return "receiver-failed";
}

/** The pause before the next attempt after `attempts` failed ones. */
export const backoffAfter = (attempts: number): Milliseconds =>
  waitOf(Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(attempts, 20)));

/** The delivery of one instance. */
export class PauseNoticeDelivery {
  #looking: Promise<void> | undefined;
  #again = false;

  constructor(private readonly parts: DeliveryParts) {}

  /**
   * One look: the mailboxes due claimed and each delivered, concurrently across mailboxes. Rejects
   * (after all of them ended) with the first store failure; a receiver's failure is a retry.
   */
  async look(): Promise<void> {
    const { pauses, clock } = this.parts;
    const recipients = this.parts.recipients();
    // no channel listens and no listener is listed: no mailbox exists, nothing to look for
    if (recipients.length === 0) return;
    const claims = await pauses.claimNoticesDue(
      clock.now(),
      CLAIMS_PER_LOOK,
      CLAIM_FOR,
      recipients,
    );
    const ended = await Promise.allSettled(claims.map((claim) => this.#deliver(claim)));
    const failed = ended.find((one) => one.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  /**
   * A transaction wrote notices: a look at once, not awaited — several in flight coalesce into one
   * more look. Never throws (a failed look is the next tick's).
   */
  kick(): void {
    if (this.#looking !== undefined) {
      this.#again = true;
      return;
    }
    this.#looking = this.#kicked().finally(() => {
      this.#looking = undefined;
    });
  }

  /** Resolves when the look in flight, and the one it coalesced, ended. */
  async settled(): Promise<void> {
    while (this.#looking !== undefined) await this.#looking;
  }

  /** Whether a kick came while a look ran (read after an await: the flag changed meanwhile). */
  #isAnother(): boolean {
    return this.#again;
  }

  async #kicked(): Promise<void> {
    do {
      this.#again = false;
      try {
        await this.look();
      } catch (error) {
        const text = `a look for pause notices failed: ${String(error)}`;
        this.parts.log.warn("pause-timers.failed", text);
      }
    } while (this.#isAnother());
  }

  /** The claimed mailbox's notices, head first, until one fails or none is left. */
  async #deliver(first: PauseNoticeClaim): Promise<void> {
    let claim: PauseNoticeClaim | undefined = first;
    while (claim !== undefined) {
      try {
        await this.#head(claim);
      } catch (error) {
        await this.#failed(claim, error);
        return;
      }
      claim = await this.parts.pauses.ackNotice(claim, this.parts.clock.now());
    }
  }

  /** Tells the receiver the head notice of the claim. */
  async #head(claim: PauseNoticeClaim): Promise<void> {
    const { mailbox } = claim;
    const notice = mailbox.notices.at(mailbox.delivered);
    if (notice === undefined) return;
    const pause = await this.parts.pauses.findByTenantIdAndPauseId(
      mailbox.tenantId,
      mailbox.pauseId,
    );
    const deps = pause === undefined ? undefined : await this.parts.rootOf(pause);
    if (pause === undefined || deps === undefined)
      throw new PauseUnreadableError(`pause ${mailbox.pauseId} is not readable here`);
    await receive(this.parts, deps, { recipient: mailbox.recipient, pause, notice });
  }

  /** A failed attempt: retried after a growing pause, or set aside when the head is too old. */
  async #failed(claim: PauseNoticeClaim, error: unknown): Promise<void> {
    const { log, clock, pauses } = this.parts;
    // a stop cut the call off: not an attempt — the claim lapses and another instance delivers
    if (this.parts.interruption()?.aborted === true) return;
    const { mailbox } = claim;
    const problem = problemOf(error);
    const now = clock.now();
    const key = pauseKeyOf(mailbox.tenantId, mailbox.pauseId);
    const text = (what: string): string =>
      `${what} to ${mailbox.recipient} (pause ${key}): ${problem}`;
    const { tenantId } = mailbox;
    log.warn("pause.notice-failed", text("a notice failed"), { tenantId });
    const writtenAt = Date.parse(mailbox.headWrittenAt ?? now.toISOString());
    if (now.getTime() - writtenAt >= this.parts.retention) {
      if (await pauses.setAsideNotices(claim, now, problem))
        log.error("pause.notice-dead", text("a notice was set aside"), { tenantId });
      return;
    }
    const next = new Date(now.getTime() + backoffAfter(mailbox.attempts));
    await pauses.retryNotice(claim, next, problem);
  }
}
