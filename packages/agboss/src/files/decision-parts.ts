import { ModelCallError } from "../models/circuit-breaker.js";
import { Decision, type DecisionImage, type DecisionState } from "../llm/decisions.js";
import type { FilePiece } from "./file-pieces.js";

/**
 * Files in a decision model's state (#899 §8): a text piece as a text, a png, jpeg or webp image as
 * `Decision.image`. Anything else — a gif, a PDF — is a part the model cannot take:
 * `ModelCallError` `model.unsupported-input`, never a lossy guess.
 */

const DECISION_IMAGES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Who asks: its cost caller and its decision model, named in the refusal. */
export interface DecisionAsker {
  readonly caller: string;
  readonly model: string;
}

/** What a state is before the pieces follow it: a text, a JSON object as its text, the parts a list has. */
function leadOf(state: DecisionState): readonly (string | DecisionImage)[] {
  if (typeof state === "string") return [state];
  return isParts(state) ? state : [JSON.stringify(state)];
}

const isParts = (state: DecisionState): state is readonly (string | DecisionImage)[] =>
  Array.isArray(state);

/** The state with the pieces after it; the state itself when there are none (byte-identical requests). */
export function decisionStateWith(
  state: DecisionState,
  pieces: readonly FilePiece[],
  asker: DecisionAsker,
): DecisionState {
  if (pieces.length === 0) return state;
  return [
    ...leadOf(state),
    ...pieces.map((piece) => {
      if (piece.kind === "text") return piece.text;
      if (piece.kind === "image" && DECISION_IMAGES.has(piece.mediaType))
        return Decision.image(`data:${piece.mediaType};base64,${piece.data}`);
      throw new ModelCallError({
        code: "model.unsupported-input",
        provider: "decisions",
        model: asker.model,
        kind: piece.kind,
        mediaType: piece.mediaType,
        message: `${asker.caller}: ${asker.model} takes png, jpeg and webp images as input, not ${piece.mediaType}`,
      });
    }),
  ];
}
