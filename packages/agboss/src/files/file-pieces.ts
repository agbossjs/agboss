import type { MessageContent } from "@langchain/core/messages";
import { blockOfPart, type ModelBlobPart } from "../models/content.js";
import { boundedText } from "../graph/agent-loop/tool-result-size.js";
import type { Bytes } from "../units/index.js";
import type { FileContent } from "./file-bytes.js";
import { isTextFormat } from "./file-needs.js";

/**
 * How one file shows in one view (#899 §2): a text format as text under its heading, an image and a PDF
 * as a part after it, a text as the transcription it is. Pure: what is sent is made here, nowhere else.
 */

/** One piece of a message: a text (a heading and what follows) or a file part. */
export type FilePiece = FileTextPiece | ModelBlobPart;

/**
 * A text piece. `isMasked`: its text went through the agent's PII policies where it was made (a
 * transcription, #899 §7) — the model boundary has nothing left to search in it.
 */
export interface FileTextPiece {
  readonly kind: "text";
  readonly text: string;
  readonly isMasked?: true;
}

const sizeLabel = (bytes: number): string =>
  bytes < 1024 ? `${String(bytes)} B` : `${String(Math.round(bytes / 1024))} KB`;

/** Where a file sits in its visit, for its heading. */
export interface FilePlace {
  readonly field: string;
  readonly producer: string;
  readonly number: number;
  readonly of: number | undefined;
}

/** `### document (from start, file 1 of 2: invoice.pdf, application/pdf, 84 KB, original)` */
export function headingOf(place: FilePlace, content: FileContent, view: string): string {
  const where =
    place.of === undefined
      ? String(place.number)
      : `${String(place.number)} of ${String(place.of)}`;
  const named = content.filename === undefined ? [] : [content.filename];
  const facts = [...named, content.mediaType, sizeLabel(content.bytes.byteLength), view];
  return `### ${place.field} (from ${place.producer}, file ${where}: ${facts.join(", ")})`;
}

const utf8Of = (content: FileContent): string => Buffer.from(content.bytes).toString("utf8");

/** A text under its heading, bounded by `maxResultSize` with the truncation note. */
export function textPiece(heading: string, text: string, maxResultSize: Bytes): FilePiece {
  const { kept, marker } = boundedText(text, maxResultSize);
  return { kind: "text", text: `${heading}\n${kept}${marker}` };
}

/**
 * A masked text after its heading, as two blocks: the heading (a file name may be personal data) is
 * masked by the model boundary, the text already was.
 */
export function maskedTextPieces(
  heading: string,
  text: string,
  maxResultSize: Bytes,
): readonly FilePiece[] {
  const { kept, marker } = boundedText(text, maxResultSize);
  return [
    { kind: "text", text: heading },
    { kind: "text", text: `${kept}${marker}`, isMasked: true },
  ];
}

/** The part a file's bytes are in a message: a PDF, an audio, a video, else an image. */
function blobPartOf(content: FileContent, data: string): ModelBlobPart {
  const { mediaType } = content;
  if (mediaType === "application/pdf")
    return {
      kind: "file",
      mediaType,
      ...(content.filename === undefined ? {} : { filename: content.filename }),
      data,
    };
  if (mediaType.startsWith("audio/")) return { kind: "audio", mediaType, data };
  if (mediaType.startsWith("video/")) return { kind: "video", mediaType, data };
  return { kind: "image", mediaType, data };
}

/** The original of a file: its text, or its heading and its part. */
export function originalPieces(
  heading: string,
  content: FileContent,
  maxResultSize: Bytes,
): readonly FilePiece[] {
  if (isTextFormat(content.mediaType)) return [textPiece(heading, utf8Of(content), maxResultSize)];
  const data = Buffer.from(content.bytes).toString("base64");
  const part = blobPartOf(content, data);
  return [{ kind: "text", text: heading }, part];
}

/** A message's content: its text, then the pieces; a plain string when there are none. */
export function contentWithPieces(text: string, pieces: readonly FilePiece[]): MessageContent {
  if (pieces.length === 0) return text;
  return [
    ...(text === "" ? [] : [{ type: "text", text }]),
    ...pieces.map((piece) =>
      piece.kind === "text" ? { type: "text", text: piece.text } : blockOfPart(piece),
    ),
  ];
}

/** The pieces of a file as a model saw it, whatever the view: a text (a transcription too) or a part. */
export const piecesOfContent = originalPieces;

/** What a text format transcribes to: itself — no model is asked. */
export const ownTranscriptOf = (content: FileContent): string | undefined =>
  isTextFormat(content.mediaType) ? utf8Of(content) : undefined;

/** The bytes a piece adds to the call: a part's file, a text's UTF-8. */
export const sizeOfPiece = (piece: FilePiece): number =>
  piece.kind === "text"
    ? Buffer.byteLength(piece.text) // UTF-8, the default
    : Buffer.from(piece.data, "base64").byteLength;
