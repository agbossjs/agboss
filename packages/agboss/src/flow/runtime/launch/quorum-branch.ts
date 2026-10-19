import type { UsageRecord } from "../../../finops/usage.js";
import type { Clock } from "../../../infrastructure/clock.js";
import type { NodeValue } from "../scope.js";
import { judgeAnswer, type ArbiterDeps } from "./arbiters.js";
import { hasExpired, watchDeadline } from "./deadline.js";
import type { LiveLaunch, LiveQuorum, QuorumMaker } from "./launch-registry.js";
import { QuorumState, quorumRuleOf } from "./quorum.js";
import { QueueTime } from "./deadline.js";
import {
  BranchVerdict,
  type BranchOutcomeRecord,
  type BranchTicket,
  type LaunchTicket,
} from "./records.js";
import type { RuntimeLaunch } from "./runtime-launch.js";

/**
 * A branch under a quorum (#279 S26): the launch's quorum state is made with its registry entry —
 * rebuilt from the records of the branches that finished before (a resume, a recovery), closed at
 * once when its `deadlineAt` has passed, else watched on the `Clock` — and after the branch's agent
 * answered, its arbiter chain runs and the answer is recorded synchronously: counted or surplus when
 * accepted, rejected otherwise. Once the quorum is decided the launch is aborted, so the branches
 * still running or waiting end `Cancelled`.
 */

/** What a quorum's entry is made from. */
export interface QuorumSite {
  readonly launch: RuntimeLaunch;
  readonly ticket: LaunchTicket;
  readonly clock: Clock;
  /** The records of the launch's branches that finished before this process ran it. */
  readonly pending: () => Promise<readonly BranchOutcomeRecord[]>;
}

/** Restores the finished branches, closes or watches the deadline, aborts a decided launch. */
async function readied(
  site: QuorumSite,
  live: Omit<LiveQuorum, "ready">,
  controller: AbortController,
): Promise<void> {
  const { state, stop, queued } = live;
  for (const record of await site.pending()) state.restore(record);
  const { deadlineAt } = site.ticket;
  if (deadlineAt !== undefined && hasExpired(site.clock, deadlineAt)) state.close();
  else if (deadlineAt !== undefined)
    watchDeadline(site.clock, deadlineAt, stop.signal, queued, () => {
      state.close();
      controller.abort();
    });
  if (state.isDecided()) controller.abort();
}

/** The maker of a launch's quorum entry; none for a launch without a quorum. */
export function quorumMakerOf(site: QuorumSite): QuorumMaker | undefined {
  const { quorum, groups } = site.launch;
  if (quorum === undefined) return undefined;
  return (controller): LiveQuorum => {
    const nodes = site.ticket.branches.map((branch) => branch.node);
    const state = new QuorumState(quorumRuleOf(quorum, groups), nodes);
    const made = { state, stop: new AbortController(), queued: new QueueTime(site.clock) };
    const ready = readied(site, made, controller);
    // a branch awaits `ready`; a failure to read the checkpoint fails it there, never unhandled
    ready.catch(() => undefined);
    return { ...made, ready };
  };
}

/** What the quorum made of a branch's answer. */
export interface QuorumMark {
  readonly verdict: BranchVerdict;
  readonly acceptedSequence?: number;
  readonly rejectedBy?: readonly string[];
}

/**
 * A judged answer: its mark and what its arbiters cost — or, when the quorum was decided before or
 * while its arbiters checked it, no mark: the branch ends `Cancelled`, its spend kept.
 */
export interface MarkedAnswer {
  readonly mark?: QuorumMark;
  readonly usage: readonly UsageRecord[];
}

/** Aborts the launch once its quorum is decided: the rest is cancelled. */
export function cancelIfDecided(live: LiveLaunch): void {
  if (live.quorum?.state.isDecided() === true) live.controller.abort();
}

/** A branch without an answer for the quorum: it failed on its own step, or was cancelled. */
export function leaveQuorum(live: LiveLaunch, ticket: BranchTicket): void {
  live.quorum?.state.leave(ticket.index);
  cancelIfDecided(live);
}

/** An answer the decided quorum cancelled: no mark, its place left, its spend kept. */
function cancelled(
  live: LiveLaunch,
  ticket: BranchTicket,
  usage: readonly UsageRecord[],
): MarkedAnswer {
  leaveQuorum(live, ticket);
  return { usage };
}

/**
 * The answer of a branch under a quorum: its arbiter chain (in the branch's frame), then its verdict
 * — synchronously after the chain, so `acceptedSequence` follows the order answers are accepted;
 * one accepted after the quorum was decided (no arbiter to wait for) is `Surplus`. A check still
 * running when the quorum is decided — `max` taken, the deadline passed — does not count (AC12):
 * the answer is cancelled, and none is checked once the quorum is decided.
 */
export async function markAnswer(
  live: LiveLaunch,
  ticket: BranchTicket,
  value: NodeValue | undefined,
  arbiters: { readonly launch: RuntimeLaunch; readonly deps: ArbiterDeps },
): Promise<MarkedAnswer | undefined> {
  const { quorum } = live;
  if (quorum === undefined) return undefined;
  const chain = arbiters.launch.launch.acceptedBy ?? [];
  const isChecked = chain.length > 0;
  if (isChecked && live.controller.signal.aborted) return cancelled(live, ticket, []);
  const site = { node: ticket.node, answer: value?.value };
  const judged = await judgeAnswer(chain, site, arbiters.deps);
  const { usage } = judged;
  if (isChecked && live.controller.signal.aborted) return cancelled(live, ticket, usage);
  if (!judged.isAccepted) {
    leaveQuorum(live, ticket);
    return { mark: { verdict: BranchVerdict.Rejected, rejectedBy: judged.rejectedBy }, usage };
  }
  const acceptance = quorum.state.accept(ticket.index);
  cancelIfDecided(live);
  return { mark: acceptance, usage };
}
