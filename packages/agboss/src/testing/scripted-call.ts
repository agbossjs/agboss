import { currentFrame } from "../flow/context/frame.js";
import type { Clock } from "../infrastructure/clock.js";
import { seconds } from "../units/index.js";
import type { ComponentScript } from "./component-script.js";
import type { RecordedInput } from "./input-match.js";
import type { ModelRequest } from "./model-script.js";
import type { ScriptedCall } from "./turns.js";

/**
 * One scripted model call (#262): the request recorded, the turn chosen by the step's input (an
 * agent's or a model router's, from its frame), and the `waitFor(…)` before it slept on the test's
 * clock — an abort while waiting cancels the call.
 */

/** The input of the step that makes the call, when its script binds to inputs. */
const stepInputOf = (script: ComponentScript): RecordedInput | undefined =>
  script.bindsInput ? currentFrame()?.services.input?.() : undefined;

/** The call's turn: recorded, chosen; throws what the script says (no script, exhausted, …). */
export function scriptedCall(
  script: ComponentScript,
  request: ModelRequest,
  checkRequest?: () => void,
): ScriptedCall {
  script.requests.push(request);
  checkRequest?.();
  return script.next(request, stepInputOf(script));
}

/** Waits the call's `waitFor(…)` on the clock; a cancelled call stops at once. */
export async function waitBeforeAnswer(
  clock: Clock,
  call: ScriptedCall,
  signal?: AbortSignal,
): Promise<void> {
  if (call.delay === 0) return;
  await clock.sleep(seconds(call.delay / 1000), signal);
  signal?.throwIfAborted();
}
