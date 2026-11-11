import { createHash } from "node:crypto";
import type { Message, Part } from "@a2a-js/sdk";
import { A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import { mediaTypeEssenceOf } from "../files/a2a-file-options.js";
import type { ServedSkill } from "./a2a-skills.js";
import { contentTypeNotSupported, fileTypeNotSupported, invalidParams } from "./a2a-wire-errors.js";

/**
 * The files of a new message (#859, the first stage — nothing fetched yet): its `raw` and `url`
 * parts, refused unless the skill's input holds files (`-32005`, as before), more than `maxFiles`
 * (`-32602 a2a.too-many-files`), of a media type the skill does not take (`-32005
 * a2a.file-media-type`), a `raw` one past `maxFileSize` or all of them past `maxTotalFileSize`
 * (`-32602`). Each names the field it fills in `metadata[A2A_SKILLS_EXTENSION].field`, or none.
 */

/** One file part of a message, as sent. */
export interface IncomingFile {
  /** Its place among the message's file parts, from 0. */
  readonly index: number;
  /** The input field it fills, when it names one. */
  readonly field: string | undefined;
  /** Its declared media type, as compared (the essence). */
  readonly mediaType: string;
  readonly filename: string | undefined;
  readonly source:
    | { readonly kind: "raw"; readonly bytes: Uint8Array }
    | { readonly kind: "url"; readonly url: string };
}

export const isFilePart = (part: Part): boolean =>
  part.content?.$case === "raw" || part.content?.$case === "url";

/** The parts of a message that are no file. */
export const nonFilePartsOf = (parts: readonly Part[]): readonly Part[] =>
  parts.filter((part) => !isFilePart(part));

/** The field a file part names: `metadata[skills-uri].field`, when a text. */
function fieldOf(part: Part): string | undefined {
  const meta: unknown = part.metadata?.[A2A_SKILLS_EXTENSION];
  const field: unknown =
    typeof meta === "object" && meta !== null ? Reflect.get(meta, "field") : undefined;
  return typeof field === "string" ? field : undefined;
}

function incomingOf(part: Part, index: number): IncomingFile {
  const { content } = part;
  const source =
    content?.$case === "raw"
      ? { kind: "raw" as const, bytes: new Uint8Array(content.value) }
      : { kind: "url" as const, url: content?.$case === "url" ? content.value : "" };
  return {
    index,
    field: fieldOf(part),
    mediaType: mediaTypeEssenceOf(part.mediaType),
    filename: part.filename === "" ? undefined : part.filename,
    source,
  };
}

const tooLarge = () =>
  invalidParams("a2a.file-too-large", "a file is larger than this agent takes");

/** The message's files, checked as said above; none for a message without. */
export function filesOfMessage(message: Message, skill: ServedSkill): readonly IncomingFile[] {
  const parts = message.parts.filter(isFilePart);
  if (parts.length === 0) return [];
  if (skill.inputFiles.length === 0) throw contentTypeNotSupported();
  const limits = skill.fileLimits;
  if (parts.length > limits.maxFiles)
    throw invalidParams("a2a.too-many-files", "the message has more files than this agent takes");
  const files = parts.map(incomingOf);
  let total = 0;
  for (const file of files) {
    if (!limits.allowedMediaTypes.includes(file.mediaType)) throw fileTypeNotSupported();
    if (file.source.kind !== "raw") continue;
    if (file.source.bytes.byteLength > limits.maxFileSize) throw tooLarge();
    total += file.source.bytes.byteLength;
  }
  if (total > limits.maxTotalFileSize)
    throw invalidParams(
      "a2a.files-too-large",
      "the message's files are larger than this agent takes",
    );
  return files;
}

/** The SHA-256 of some bytes, lower-case hex. */
export const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
