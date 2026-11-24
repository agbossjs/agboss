import { callsOf, invalidCallsOf } from "./deps.js";
import type { AIMessage } from "@langchain/core/messages";

/**
 * Per-move channels by call id (#1295c): a key set to `undefined` is dropped, so a call id the
 * model reuses in a later move meets nothing of the old one.
 */
export const mergeMove = <TValue>(
  left: Readonly<Record<string, TValue>>,
  right: Readonly<Record<string, TValue | undefined>>,
): Record<string, TValue> =>
  Object.fromEntries(
    Object.entries({ ...left, ...right }).filter(([, value]) => value !== undefined),
  ) as Record<string, TValue>;

/** The entries of the calls of a new move, all dropped: what a move starts from. */
export function freshEntriesOf(move: AIMessage): {
  readonly results: Record<string, undefined>;
  readonly decisions: Record<string, undefined>;
  readonly prepared: Record<string, undefined>;
  readonly questionAnswers: Record<string, undefined>;
  readonly callRecords: Record<string, undefined>;
} {
  const fresh = Object.fromEntries(
    [...callsOf(move), ...invalidCallsOf(move)].map((call) => [call.callId, undefined]),
  );
  return {
    results: fresh,
    decisions: fresh,
    prepared: fresh,
    questionAnswers: fresh,
    callRecords: fresh,
  };
}
