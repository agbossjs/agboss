import type { GuardrailSide } from "../components/policy-decorators.js";
import type { FileContent } from "../files/file-bytes.js";
import type { FilePiece } from "../files/file-pieces.js";

/** What a guardrail checks (#120, #899 §8): the text and the files the guarded model reads with it. */

/** One file in one view as the guarded model reads it: the file, and the pieces it is sent as. */
export interface GuardedFile {
  readonly content: FileContent;
  readonly pieces: readonly FilePiece[];
}

/**
 * What a guardrail checks: the text, whose model it guards, from which side — and the files the model
 * reads with it (#899 §8), in the views the model got.
 */
export interface GuardedText {
  readonly text: string;
  readonly element: string;
  readonly side: GuardrailSide;
  readonly files?: readonly GuardedFile[];
}

/** The pieces of every file, in order: what a model guardrail is sent after the text. */
export const piecesOfGuarded = (checked: GuardedText): readonly FilePiece[] =>
  (checked.files ?? []).flatMap((file) => file.pieces);

/** The text and the text of the files (a transcription, a text format) as one text: all a text-only code guardrail can read. */
export const textOfGuarded = (checked: GuardedText): string =>
  [
    checked.text,
    ...piecesOfGuarded(checked).flatMap((piece) => (piece.kind === "text" ? [piece.text] : [])),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
