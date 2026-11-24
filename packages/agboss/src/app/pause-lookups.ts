import type { PauseChannel, PauseTarget } from "../flow/runtime/pause-channel.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";

/** What a workflow's pause targets and channels are looked up by (#267, #1307). */
export interface PauseLookups {
  readonly targetOf: (targetName: string) => PauseTarget;
  readonly channelOf: (channelName: string) => PauseChannel;
  /** The names of its channels: the receivers of its pauses' notices (#940). */
  readonly channelNames: readonly string[];
}

/**
 * The workflow's pause targets of a name and their channels (#267, #1307). They are created here,
 * with the app (so their lifecycle hooks run and a missing dependency fails at start).
 */
export const pauseLookups = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): PauseLookups => {
  const targets = bundle.pauseTargets?.(services) ?? new Map<string, PauseTarget>();
  const channels = new Map<string, PauseChannel>(
    [...targets.values()].flatMap((target) => [...target.channels]),
  );
  return {
    targetOf: (targetName) => {
      const target = targets.get(targetName);
      if (!target) throw new Error(`Unknown pause target: ${targetName}`);
      return target;
    },
    channelOf: (channelName) => {
      const channel = channels.get(channelName);
      if (!channel) throw new Error(`Unknown channel: ${channelName}`);
      return channel;
    },
    channelNames: [...channels.keys()],
  };
};
