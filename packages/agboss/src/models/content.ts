import { createHash } from "node:crypto";
import type { ContentBlock, MessageContent } from "@langchain/core/messages";

/**
 * What a model reads besides text (#899 §2): one input kind, and the parts a message is made of.
 * `data` is the file's bytes in base64 — JSON, so a checkpoint and a transport carry it as it is.
 */

/** What a model takes as input; OpenRouter's `architecture.input_modalities` as is. */
export type ModelInputKind = "text" | "image" | "file" | "audio" | "video";

export interface ModelTextPart {
  readonly kind: "text";
  readonly text: string;
}

export interface ModelImagePart {
  readonly kind: "image";
  readonly mediaType: string;
  readonly data: string;
  readonly detail?: "low" | "high" | "auto";
}

export interface ModelFilePart {
  readonly kind: "file";
  readonly mediaType: string;
  readonly filename?: string;
  readonly data: string;
}

/** A part of a message to a model. */
export type ModelInputPart = ModelTextPart | ModelImagePart | ModelFilePart;

/** What a transport provider is handed: the same shapes. */
export type ModelProviderPart = ModelInputPart;

/** The kind of input a media type is for a model that reads it as a file (§4). */
export function inputKindOfMediaType(mediaType: string): ModelInputKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return mediaType === "application/pdf" ? "file" : "text";
}

/** The block of a message's content the agent loop hands LangChain; `wire.ts` maps it, no library does. */
export const PART_BLOCK_TYPE = "agboss_part" as const;

/** A non-text part as a LangChain content block. */
export function blockOfPart(part: ModelImagePart | ModelFilePart): ContentBlock {
  return { type: PART_BLOCK_TYPE, ...part };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The non-text part a content block is, if it is one. */
export function partOfBlock(block: unknown): ModelImagePart | ModelFilePart | undefined {
  if (!isRecord(block) || block.type !== PART_BLOCK_TYPE) return undefined;
  const { kind, mediaType, data } = block;
  if (typeof mediaType !== "string" || typeof data !== "string") return undefined;
  if (kind === "image") return { kind, mediaType, data, ...detailOf(block.detail) };
  if (kind !== "file") return undefined;
  const { filename } = block;
  return { kind, mediaType, data, ...(typeof filename === "string" ? { filename } : {}) };
}

/** An image part's `detail`, when it is one of the three the wire knows. */
function detailOf(detail: unknown): { readonly detail?: "low" | "high" | "auto" } {
  return detail === "low" || detail === "high" || detail === "auto" ? { detail } : {};
}

/** What an event, a trace or a cassette shows of a part: never its bytes (#899 §9). */
export interface PartMeta {
  readonly type: "agboss_part";
  readonly kind: "image" | "file";
  readonly mediaType: string;
  readonly filename?: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** The part as it is shown: `{ kind, mediaType, filename?, sizeBytes, sha256 }` of its bytes. */
export function partMetaOf(part: ModelImagePart | ModelFilePart): PartMeta {
  const bytes = Buffer.from(part.data, "base64");
  return {
    type: PART_BLOCK_TYPE,
    kind: part.kind,
    mediaType: part.mediaType,
    ...(part.kind === "file" && part.filename !== undefined ? { filename: part.filename } : {}),
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** The non-text parts of a message's content, in order. */
export function partsOfContent(
  content: MessageContent,
): readonly (ModelImagePart | ModelFilePart)[] {
  if (typeof content === "string") return [];
  return content.flatMap((block) => partOfBlock(block) ?? []);
}

/** A text and its parts as one message content: a string when there are no parts (byte-identical requests). */
export function contentOf(
  text: string,
  parts: readonly (ModelImagePart | ModelFilePart)[],
): MessageContent {
  if (parts.length === 0) return text;
  return [...(text === "" ? [] : [{ type: "text", text }]), ...parts.map(blockOfPart)];
}
