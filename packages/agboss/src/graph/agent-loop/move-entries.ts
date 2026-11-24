import { createHash } from "node:crypto";
import { sortedJson } from "../../flow/runtime/json.js";
import { PreparedFrom, type CallDecision, type PreparedCall } from "./state.js";
import { callsOf, invalidCallsOf, type ToolCallRequest } from "./deps.js";
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
export function freshEntriesOf(move: AIMessage | null): {
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

/**
 * A decision without the arguments the approver typed (#1295c): they were prepared once more and
 * are kept as prepared; none when the decision had no override.
 */
export function withoutOverride(decided: CallDecision | undefined): CallDecision | undefined {
  if (decided?.overrideArguments === undefined) return undefined;
  const { approved, by, reason } = decided;
  return { approved, by, ...(reason === undefined ? {} : { reason }) };
}

/** A call to a tool the agent does not have, prepared as an invalid call: never left unprepared (#1295c). */
export const unknownToolPrepared = (call: ToolCallRequest): PreparedCall => ({
  tool: call.tool,
  argsDigest: argsDigestOf(call.args),
  args: call.args,
  from: PreparedFrom.Model,
  kind: "invalid",
});

/** The digest of the arguments the model gave a call. */
export const argsDigestOf = (args: Record<string, unknown>): string =>
  createHash("sha256").update(sortedJson(args)).digest("hex");
