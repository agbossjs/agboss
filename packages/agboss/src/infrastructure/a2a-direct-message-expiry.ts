import type { UnknownCostTally } from "../core/observer-manager.js";
import { CostSource } from "../finops/cost-source.js";
import { ZERO_USAGE } from "../finops/usage.js";
import { usd, type Milliseconds } from "../units/index.js";
import type {
  A2ADirectMessageRecord,
  A2ADirectMessageRepository,
} from "./a2a-direct-message.repository.js";
import type { A2AFileRepository } from "./a2a-file.repository.js";
import type { Clock } from "./clock.js";
import type { CostLedgerRepository, LedgerEntry } from "./cost-ledger.repository.js";
import type { Expiry } from "./expiry.js";

/**
 * What becomes of a direct A2A message's attempt that was lost (#860, design §5): its run stopped
 * without its reply — a crash, a frozen instance — and its `expiresAt` passed. The one instance
 * that takes it over (a resend's `retakeIfExpired`, or the sweep's `deleteIfInFlight`: the store
 * lets one win) records one entry of unknown cost when the skill can call a model — its calls may
 * have been billed, or not (#853, `CostSource.Unknown`: no amount, counted apart) — under the
 * attempt's own ledger id, so a second record of it adds nothing, and removes the attempt's files.
 */

/** What settling a lost attempt writes to. */
export interface LostAttemptSources {
  readonly ledger: Pick<CostLedgerRepository, "saveAll">;
  readonly files: Pick<A2AFileRepository, "deleteByOwner">;
  readonly clock: Pick<Clock, "now">;
  /** The instance's tally of Unknown-cost entries (#875); absent: not counted. */
  readonly unknownCosts?: UnknownCostTally | undefined;
}

/** The ledger id of a lost attempt's entry: one per attempt, ever. */
export const lostAttemptLedgerIdOf = (lost: Pick<A2ADirectMessageRecord, "tenantId" | "attemptId">) =>
  `unknown:a2a-msg:${lost.tenantId}:${lost.attemptId}`;

/** The entry of unknown cost of a lost attempt. */
const unknownEntryOf = (lost: A2ADirectMessageRecord, madeAt: Date): LedgerEntry => ({
  ...ZERO_USAGE,
  caller: `a2a-message:${lost.skill}`,
  model: "unknown",
  costUsd: usd(0),
  costSource: CostSource.Unknown,
  ledgerId: lostAttemptLedgerIdOf(lost),
  madeAt,
});

/** Settles an attempt this caller took over: its Unknown-cost entry (a model skill's), its files. */
export async function settledLostAttempt(
  sources: LostAttemptSources,
  lost: A2ADirectMessageRecord,
): Promise<void> {
  if (lost.callsModel) {
    // no budget counts an unknown cost: the entry is kept with no counter
    await sources.ledger.saveAll([], [unknownEntryOf(lost, sources.clock.now())]);
    sources.unknownCosts?.recorded(lost.skill, 1);
  }
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
      if (await messages.deleteIfInFlight(each, each.attemptId)) await settledLostAttempt(sources, each);
    if (lost.length < PAGE) return;
  }
}

/**
 * The recovery sweep's removal of direct messages (#860): first the attempts lost in flight (each
 * settled once), then the messages accepted before the cutoff — `retention.a2aMessages` — a page at
 * a time, with their ids' claims and their attempts' files; at most `MAX_PAGES` pages of each per look.
 */
export const a2aDirectMessageExpiryOf = (sources: A2ADirectMessageExpirySources): Expiry => ({
  what: "the direct A2A messages",
  remove: async (cutoff: Date) => {
    await sweptLostAttempts(sources);
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const gone = await sources.messages.deleteByCreatedAtBefore(cutoff, PAGE);
      for (const message of gone)
        await sources.files.deleteByOwner({ tenantId: message.tenantId, ownerId: message.attemptId });
      if (gone.length < PAGE) return;
    }
  },
  retention: sources.retention,
});
