import type { LoopPii } from "../../../graph/agent-loop/runner.js";
import { tokenFieldMask } from "../../../pii/field-masks.js";
import type { PiiRuntime } from "../../../pii/runtime.js";
import type { RuntimeNode } from "../graph-model.js";
import { inputMessageOf } from "../input-message.js";
import type { ExecutionStateType } from "../state.js";

/** A model node's input message as its model reads it, and what of PII it hands on (#120). */
export interface BoundaryInput {
  readonly input: string;
  readonly pii: LoopPii;
}

/**
 * The input message of an agent or a model router with its `sensitive` fields through their
 * actions (their tokens made with the execution's key, else the field key — #334), and the
 * execution's sensitive context values and key.
 * Without a PII runtime (a graph on its own) the message is as it is.
 */
export function boundaryInputOf(
  node: RuntimeNode,
  state: ExecutionStateType,
  pii: PiiRuntime | undefined,
): BoundaryInput {
  const key = state.piiKey;
  if (pii === undefined)
    return { input: inputMessageOf(node.fields, state), pii: { tokens: {}, values: [], key } };
  const fields = tokenFieldMask(key ?? pii.fieldKey, state.piiTokens);
  const input = inputMessageOf(node.fields, state, fields.mask);
  const values = pii.contextValuesOf(state.contexts);
  return { input, pii: { tokens: fields.tokens, values, key } };
}
