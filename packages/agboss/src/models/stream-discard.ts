import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";

/**
 * The custom LangChain event a model dispatches when the text it streamed is void (#1005): a
 * provider died after tokens went out and a fallback answers from the start. The answering call's stream handler
 * retracts what it streamed and takes the text that follows as a new start (`stream-broken`, #1006).
 */
export const STREAM_DISCARD_EVENT = "agboss/stream-discard";

/** Tells the call's stream handler the text so far is void; `reason` says why (for traces). */
export async function discardStreamedText(
  runManager: CallbackManagerForLLMRun | undefined,
  reason: string,
): Promise<void> {
  await runManager?.handleCustomEvent(STREAM_DISCARD_EVENT, { reason });
}
