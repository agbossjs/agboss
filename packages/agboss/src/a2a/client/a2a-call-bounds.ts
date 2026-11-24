import { currentFrame } from "../../flow/context/frame.js";
import type { Milliseconds } from "../../units/index.js";
import type { A2AClientCall } from "./a2a-client-options.js";

/** A call's own signal, else the running step's (it ends with the step), else none. */
export function stepSignalOf(call: Pick<A2AClientCall, "signal">): AbortSignal | undefined {
  if (call.signal !== undefined) return call.signal;
  const frame = currentFrame();
  // a frame whose step has ended binds nothing
  const isEnded = (frame as { isClosed?: () => boolean } | undefined)?.isClosed?.() === true;
  return frame === undefined || isEnded ? undefined : frame.execution.signal;
}

/** A call with the step's signal and the agent's `timeout` where the call gave none. */
export function boundCallOf(call: A2AClientCall, timeout: Milliseconds | undefined): A2AClientCall {
  const signal = stepSignalOf(call);
  const bound = call.timeout ?? timeout;
  return {
    ...call,
    ...(signal === undefined ? {} : { signal }),
    ...(bound === undefined ? {} : { timeout: bound }),
  };
}
