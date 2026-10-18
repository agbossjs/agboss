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
 * actions (their tokens made with the field key), and the execution's sensitive context values.
 * Without a PII runtime (a graph on its own) the message is as it is.
 */
export function boundaryInputOf(
  node: RuntimeNode,
  state: ExecutionStateType,
  pii: PiiRuntime | undefined,
): BoundaryInput {
  if (pii === undefined)
    return { input: inputMessageOf(node.fields, state), pii: { tokens: {}, values: [] } };
  const fields = tokenFieldMask(pii.fieldKey, state.piiTokens);
  const input = inputMessageOf(node.fields, state, fields.mask);
  return { input, pii: { tokens: fields.tokens, values: pii.contextValuesOf(state.contexts) } };
}
