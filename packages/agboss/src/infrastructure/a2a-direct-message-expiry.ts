import type { Milliseconds } from "../units/index.js";
import type {
  A2ADirectMessageRecord,
  A2ADirectMessageRepository,
} from "./a2a-direct-message.repository.js";
import type { A2AFileRepository } from "./a2a-file.repository.js";
import type { Clock } from "./clock.js";
import type { Expiry } from "./expiry.js";

/**
 * What becomes of a direct A2A message's attempt that was lost (#860, design §5): its run stopped
 * without its reply — a crash, a frozen instance — and its `expiresAt` passed. The one instance
 * that takes the message over (a resend's `retakeIfExpired`, or the sweep's `deleteIfInFlight`: the
 * store lets one win) removes the attempt's files. Its call of unknown cost is the run's, recorded
 * where every lost pass is (#853): by the instance that takes the run's lease over and ends it
 * without a pass, in its kept record (`app/lost-attempt.ts`, #860 D1).
 */

/** What settling a lost attempt writes to. */
export interface LostAttemptSources {
  readonly files: Pick<A2AFileRepository, "deleteByOwner">;
  readonly clock: Pick<Clock, "now">;
}

/** Settles an attempt this caller took over: its files. */
export async function settledLostAttempt(
  sources: LostAttemptSources,
  lost: A2ADirectMessageRecord,
): Promise<void> {
  await sources.files.deleteByOwner({ tenantId: lost.tenantId, ownerId: lost.attemptId });
}

/** How many messages one page of the sweep reads or removes. */
const PAGE = 100;
/** How many pages one look goes through at most: the rest is the next look's (bounded work). */
const MAX_PAGES = 20;

/** What the sweep of the direct messages reads and writes. */
export interface A2ADirectMessageExpirySources extends LostAttemptSources {
  readonly messages: A2ADirectMessageRepository;
  readonly retention: Milliseconds;
}

/** The lost attempts the store holds now, a page at a time: each settled by whoever removes it. */
async function sweptLostAttempts(sources: A2ADirectMessageExpirySources): Promise<void> {
  const { messages } = sources;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const lost = await messages.findAllInFlightByExpiresAtBefore(sources.clock.now(), PAGE);
    for (const each of lost)
      if (await messages.deleteIfInFlight(each, each.attemptId))
        await settledLostAttempt(sources, each);
    if (lost.length < PAGE) return;
  }
}

/**
 * The recovery sweep's removal of direct messages (#860): first the attempts lost in flight (each
 * settled once), then the completed messages accepted before the cutoff — `retention.a2aMessages` —
 * a page at a time, with their ids' claims and their attempts' files; at most `MAX_PAGES` pages of
 * each per look. A message in flight is never removed by age (#860 D2).
 */
export const a2aDirectMessageExpiryOf = (sources: A2ADirectMessageExpirySources): Expiry => ({
  what: "the direct A2A messages",
  remove: async (cutoff: Date) => {
    await sweptLostAttempts(sources);
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const gone = await sources.messages.deleteByCreatedAtBefore(cutoff, PAGE);
      for (const message of gone)
        await sources.files.deleteByOwner({
          tenantId: message.tenantId,
          ownerId: message.attemptId,
        });
      if (gone.length < PAGE) return;
    }
  },
  retention: sources.retention,
});
