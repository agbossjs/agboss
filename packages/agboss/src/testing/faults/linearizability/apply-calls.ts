import { fencedKeyIdentityOf } from "../../../infrastructure/fenced-effect-key.js";
import type { FencedEffectKey } from "../../../infrastructure/fenced-effect.repository.js";
import {
  callClaimed,
  callEnded,
  callFound,
  callSaved,
  type CallKeyFacts,
  type ReadCall,
} from "../../contracts/models/call-model.js";
import { effectWritten, treeOf, type FencingState } from "../../contracts/models/lease-model.js";
import { stableJson } from "../../../terns/versions.js";
import { StoreHoldPoint } from "../store-points.js";
import { UNKNOWN, type CheckedOperation } from "./operations.js";

/**
 * The fenced operations of a recorded history on the sequential model (#533 item 5): the fenced
 * effect's write and the outbound call's reads and compare-and-sets.
 */

/** Whether `output` is `answer`, an unknown output being any. */
export const isSame = (output: unknown, answer: unknown): boolean =>
  output === UNKNOWN || stableJson(output) === stableJson(answer);

/** The fenced key the history kept, as the call model reads it. */
export function callKeyOf(input: Readonly<Record<string, unknown>>): CallKeyFacts {
  const key = input as unknown as FencedEffectKey;
  return {
    tree: treeOf(key.tenantId, key.leaseExecutionId),
    token: key.token,
    scope: key.scopeKey,
    identity: fencedKeyIdentityOf(key),
    leaseExecutionId: key.leaseExecutionId,
  };
}

/** A fenced operation's answer as the model names it. */
const fencedOutput = (operation: CheckedOperation): unknown => {
  const { output } = operation;
  if (
    operation.kind !== StoreHoldPoint.FencedEffectWrite ||
    output === UNKNOWN ||
    output === "fenced"
  )
    return output;
  return (output as { status: string }).status;
};

export function callApplied(
  state: FencingState,
  operation: CheckedOperation,
  now: number,
): FencingState | undefined {
  const key = callKeyOf(operation.input);
  const input = operation.input as {
    attemptOwner?: string;
    expected?: ReadCall;
    claim?: { attempt: number; attemptOwner: string };
  };
  const step = (() => {
    switch (operation.kind) {
      case StoreHoldPoint.FencedEffectWrite:
        return effectWritten(state, key, key.identity, now);
      case StoreHoldPoint.OutboundFindByKey:
        return callFound(state, key, now);
      case StoreHoldPoint.OutboundSaveIfAbsent:
        return callSaved(state, key, input.attemptOwner ?? "", now);
      case StoreHoldPoint.OutboundMarkPending:
        return callClaimed(
          state,
          key,
          input.expected ?? { status: "pending", attempt: 0, attemptOwner: "" },
          input.claim ?? { attempt: 0, attemptOwner: "" },
          now,
        );
      default:
        return callEnded(
          state,
          key,
          input.attemptOwner ?? "",
          operation.kind === StoreHoldPoint.OutboundMarkCompleted ? "completed" : "failed",
          now,
        );
    }
  })();
  return isSame(fencedOutput(operation), step.answer) ? step.state : undefined;
}
