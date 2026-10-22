import {
  logWithdrawFailed,
  withdrawFromChannel,
  type ChannelWithdrawalCall,
} from "../channels/channel-withdrawal.js";
import type { FrameSpec } from "../flow/context/frame.js";
import type { PauseChannel } from "../flow/runtime/pause.js";
import type { Clock } from "../infrastructure/clock.js";
import { systemClock } from "../infrastructure/clock.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import type { PauseWithdrawn, WithdrawnPause } from "../pause/index.js";
import type { Milliseconds } from "../units/index.js";
import type { AppDeps } from "./app-deps.js";
import { ownDepsOf, pauseFrameOf, treeStateOf, withdrawalTreeOf } from "./pause-frame.js";

/**
 * The channels of a workflow's app told about withdrawn pauses (#337): the pause's channel found by
 * its workflow (a child's too) and its name, its frame — its own step's, the pass's tree, or the
 * root's checkpoint and the thread's owner after the tree ended or was cancelled — and its tool's
 * `timeout`. The module `withWithdrawals` loads with the first withdrawal.
 */

/** What telling a pause's channel needs from its workflow's app. */
export interface WithdrawalParts {
  /** The pause's channel, by its workflow and name; `undefined` when the app has none of that name. */
  readonly channelOf: (pause: PauseRecord) => PauseChannel | undefined;
  readonly frameOf: (withdrawn: WithdrawnPause) => Promise<FrameSpec>;
  /** The waiting tool's `timeout`. */
  readonly timeoutOf: (pause: PauseRecord) => Milliseconds;
  readonly clock: Clock;
  readonly log: FrameworkLog;
}

/** What telling one pause's channel takes. */
async function callOf(
  parts: WithdrawalParts,
  withdrawn: WithdrawnPause,
): Promise<ChannelWithdrawalCall> {
  const { pause, resolution } = withdrawn;
  const channel = parts.channelOf(pause);
  if (channel === undefined) throw new Error(`unknown channel ${pause.channel}`);
  const frame = await parts.frameOf(withdrawn);
  const { clock, log } = parts;
  const call = { channel: pause.channel, sender: channel.sender, pause, resolution, frame };
  return { ...call, timeout: parts.timeoutOf(pause), clock, log };
}

/** The withdrawals told through `parts`: each once; a failure anywhere is a warning, never a throw. */
export const pauseWithdrawalsOf =
  (parts: WithdrawalParts): PauseWithdrawn =>
  async (withdrawn) => {
    try {
      await withdrawFromChannel(await callOf(parts, withdrawn));
    } catch (error) {
      logWithdrawFailed(parts.log, { channel: withdrawn.pause.channel, ...withdrawn }, error);
    }
  };

/** The pause's frame: its own step's, or rebuilt from the tree (the pass's, or the checkpoint's). */
async function frameIn(deps: AppDeps, withdrawn: WithdrawnPause): Promise<FrameSpec> {
  if (withdrawn.frame !== undefined) return withdrawn.frame;
  const { pause } = withdrawn;
  const tree =
    withdrawn.tree ??
    (await withdrawalTreeOf(deps, pause, await treeStateOf(deps, pause.rootExecutionId)));
  return pauseFrameOf(deps, pause, tree);
}

/** The withdrawals of a workflow's app, on its run deps (the module the seam loads). */
export const pauseWithdrawalsFor = (deps: AppDeps): PauseWithdrawn =>
  pauseWithdrawalsOf({
    channelOf: (pause) => ownDepsOf(deps, pause.workflow).channelOf?.(pause.channel),
    frameOf: (withdrawn) => frameIn(deps, withdrawn),
    timeoutOf: (pause) => ownDepsOf(deps, pause.workflow).tools(pause.ask.tool).timeout,
    clock: deps.clock ?? systemClock,
    log: deps.log,
  });
