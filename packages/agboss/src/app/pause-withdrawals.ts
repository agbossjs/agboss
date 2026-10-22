import {
  logWithdrawFailed,
  withdrawFromChannel,
  type ChannelWithdrawalCall,
} from "../channels/channel-withdrawal.js";
import type { FrameSpec } from "../flow/context/frame.js";
import type { GraphDeps } from "../graph/deps.js";
import { systemClock } from "../infrastructure/clock.js";
import type { PauseWithdrawn, WithdrawnPause } from "../pause/index.js";
import { DEFAULT_TOOL_TIMEOUT } from "../tools/index.js";
import type { Milliseconds } from "../units/index.js";
import type { AppDeps } from "./app-deps.js";
import { graphDepsNamed, pauseFrameOf, treeStateOf, withdrawalTreeOf } from "./pause-frame.js";

/**
 * The channels of a workflow's app told about withdrawn pauses (#337): the pause's channel found by
 * its workflow (a child's too) and its name, its frame rebuilt from the tree — the pass's own
 * values, or the root's checkpoint and the thread's owner after the tree ended or was cancelled —
 * and its tool's `timeout`. The module `lazyPauseWithdrawals` loads with the first withdrawal.
 */

/** How long `withdraw` may run: the waiting tool's `timeout`, else the default one. */
function timeoutOf(own: GraphDeps<string>, tool: string): Milliseconds {
  try {
    return own.tools(tool).timeout;
  } catch {
    return DEFAULT_TOOL_TIMEOUT;
  }
}

/** The pause's frame: its own step's, or rebuilt from the tree. */
async function frameOf(deps: AppDeps, withdrawn: WithdrawnPause): Promise<FrameSpec> {
  if (withdrawn.frame !== undefined) return withdrawn.frame;
  const { pause } = withdrawn;
  const tree =
    withdrawn.tree ??
    (await withdrawalTreeOf(deps, pause, await treeStateOf(deps, pause.rootExecutionId)));
  return pauseFrameOf(deps, pause, tree);
}

/** What telling one pause's channel takes. */
async function callOf(deps: AppDeps, withdrawn: WithdrawnPause): Promise<ChannelWithdrawalCall> {
  const { pause, resolution } = withdrawn;
  const own = graphDepsNamed(deps, pause.workflow) ?? deps;
  const channel = (own.channelOf ?? deps.channelOf)?.(pause.channel);
  if (channel === undefined) throw new Error(`Unknown channel: ${pause.channel}`);
  return {
    channel: pause.channel,
    sender: channel.sender,
    pause,
    resolution,
    frame: await frameOf(deps, withdrawn),
    timeout: timeoutOf(own, pause.ask.tool),
    clock: deps.clock ?? systemClock,
    log: deps.log,
  };
}

/** The app's withdrawals: each told once; a failure anywhere is a warning, never a throw. */
export const pauseWithdrawalsFor =
  (deps: AppDeps): PauseWithdrawn =>
  async (withdrawn) => {
    try {
      await withdrawFromChannel(await callOf(deps, withdrawn));
    } catch (error) {
      logWithdrawFailed(deps.log, { channel: withdrawn.pause.channel, ...withdrawn }, error);
    }
  };
