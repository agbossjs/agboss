import type { UsageRecord } from "../../../finops/usage.js";
import type { Clock } from "../../../infrastructure/clock.js";
import type { NodeValue } from "../scope.js";
import { judgeAnswer, type ArbiterDeps } from "./arbiters.js";
import { hasExpired, watchDeadline } from "./deadline.js";
import type { LiveLaunch, LiveQuorum, QuorumMaker } from "./launch-registry.js";
import { QuorumState, quorumRuleOf } from "./quorum.js";
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
  state: QuorumState,
  controller: AbortController,
  stop: AbortSignal,
): Promise<void> {
  for (const record of await site.pending()) state.restore(record);
  const { deadlineAt } = site.ticket;
  if (deadlineAt !== undefined && hasExpired(site.clock, deadlineAt)) state.close();
  else if (deadlineAt !== undefined)
    watchDeadline(site.clock, deadlineAt, stop, () => {
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
    const stop = new AbortController();
    const ready = readied(site, state, controller, stop.signal);
    // a branch awaits `ready`; a failure to read the checkpoint fails it there, never unhandled
    ready.catch(() => undefined);
    return { state, ready, stop };
  };
}

/** What the quorum made of a branch's answer. */
export interface QuorumMark {
  readonly verdict: BranchVerdict;
  readonly acceptedSequence?: number;
  readonly rejectedBy?: readonly string[];
}

/** A judged answer: its mark and what its arbiters cost. */
export interface MarkedAnswer {
  readonly mark: QuorumMark;
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

/**
 * The answer of a branch under a quorum: its arbiter chain (in the branch's frame), then its verdict
 * — synchronously after the chain, so `acceptedSequence` follows the order answers are accepted;
 * one accepted after the quorum was decided is `Surplus`. A launch already decided cancels the
 * answer before its arbiters are called (no check is paid for a decided quorum).
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
  if (chain.length > 0) live.controller.signal.throwIfAborted();
  const site = { node: ticket.node, answer: value?.value };
  const judged = await judgeAnswer(chain, site, arbiters.deps);
  const { usage } = judged;
  if (!judged.isAccepted) {
    leaveQuorum(live, ticket);
    return { mark: { verdict: BranchVerdict.Rejected, rejectedBy: judged.rejectedBy }, usage };
  }
  const acceptance = quorum.state.accept(ticket.index);
  cancelIfDecided(live);
  return { mark: acceptance, usage };
}
