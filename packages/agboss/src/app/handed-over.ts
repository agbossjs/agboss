import { ApplicationStoppingError } from "./application-stopping.js";
import { ExecutionLeaseLostError } from "./lease-lost.js";

/**
 * Work that stopped without failing (#265): its instance lost the tree's lease
 * (`ExecutionLeaseLostError`), or stopped and interrupted it (`ApplicationStoppingError`, the
 * shutdown timeout passed). Another instance continues the tree: it reaches neither `.onError`,
 * `onError` nor the record (which stays `running`), and the tree keeps its keys.
 */
export const isHandedOver = (error: unknown): error is HandedOver =>
  error instanceof ExecutionLeaseLostError || error instanceof ApplicationStoppingError;

/** The two ways work is handed over. */
export type HandedOver = ExecutionLeaseLostError | ApplicationStoppingError;

/** Why a signal stopped the work, when it was handed over; `undefined` otherwise. */
export function handedOverReason(signal: AbortSignal | undefined): HandedOver | undefined {
  const reason: unknown = signal?.aborted === true ? signal.reason : undefined;
  return isHandedOver(reason) ? reason : undefined;
}
