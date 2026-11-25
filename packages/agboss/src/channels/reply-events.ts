import { totalCost } from "../finops/usage.js";
import type { ExecutionObserverManager } from "../core/observer-manager.js";
import type { FrameSpec } from "../flow/context/frame.js";
import { nodeEventOf } from "../flow/observers/execution-event.js";
import { ChannelInterpreterOutcome } from "../flow/observers/channel-interpreter.js";
import type { AssembledReplyInterpreter } from "./discovery.js";
import type { ReplyReading } from "./reply-reader.js";

/**
 * A reading between `onChannelInterpreterStart` and `onChannelInterpreterEnd` (#1310, #1343): told
 * to the observers of the paused execution — masked by its workflow's policies — with the waiting
 * step of its frame. The end is told for every start, also when the interpreter itself throws.
 */

/** What the events are told with: who reads, in whose frame. */
interface ReadingSite {
  readonly observer: ExecutionObserverManager | undefined;
  readonly frame: FrameSpec;
  readonly interpreter: AssembledReplyInterpreter;
}

/** `read` between the two events. */
export async function observedReading(
  { observer, frame, interpreter }: ReadingSite,
  read: () => Promise<ReplyReading>,
): Promise<ReplyReading> {
  if (observer === undefined) return read();
  const about = {
    ...nodeEventOf(frame),
    interpreter: interpreter.name,
    target: interpreter.target,
    isCode: interpreter.model === undefined,
  };
  await observer.onChannelInterpreterStart(about);
  let reading: ReplyReading | undefined;
  try {
    reading = await read();
    return reading;
  } finally {
    // a reading that threw spent what the tree's ledger has: the end names no cost then
    await observer.onChannelInterpreterEnd({
      ...about,
      outcome:
        reading?.kind === "read"
          ? ChannelInterpreterOutcome.Read
          : ChannelInterpreterOutcome.Unreadable,
      costUsd: totalCost(reading?.usage ?? []),
    });
  }
}
