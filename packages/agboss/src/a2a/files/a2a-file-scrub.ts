import { randomUUID } from "node:crypto";
import { BaseMessage, type ContentBlock } from "@langchain/core/messages";
import { definedOf } from "../../infrastructure/clock.js";
import { partMetaOf, partOfBlock } from "../../models/content.js";
import { messageWithBlocks } from "../../pii/message-mask.js";
import { isDtoOrPlainObject, likeOriginal } from "../../dto/plain.js";
import { fieldsOf } from "../../dto/metadata.js";
import type { DtoClass } from "../../dto/types.js";
import { FileDto, redactedFileOf } from "../../dto/standard/file.js";

/**
 * Where a file descriptor is shown (#899 §0), found by what the value is. A renderer that knows the
 * DTO (the input message, a tool's result) walks it (`scrubbedFilesOfDto`); one that holds plain data
 * (a record, an event, a trace, a turn) walks the value (`redactedFilesIn`, `withoutInlineBytes`).
 * A descriptor is a record with a `mediaType` and exactly one of `fileId`, `inline`, `url`.
 */

type Plain = Readonly<Record<string, unknown>>;

const isPlain = (value: unknown): value is Plain => isDtoOrPlainObject(value);

const SOURCE_KEYS = ["fileId", "inline", "url"] as const;

/** Whether a value is the descriptor of a file (`FileDto`'s shape). */
export function isFileDescriptor(value: unknown): value is FileDto {
  if (!isPlain(value) || typeof value.mediaType !== "string") return false;
  return SOURCE_KEYS.filter((key) => typeof value[key] === "string").length === 1;
}

/** The deepest value the walks go into: past it nothing is shown. */
const MAX_DEPTH = 64;
const TOO_DEEP = "[too deep]";

/** A block of a message to a model: a file part shows as its meta, never its bytes. */
const blockShown = (block: ContentBlock): ContentBlock => {
  const part = partOfBlock(block);
  return part === undefined ? block : { ...partMetaOf(part) };
};

/** A value with every descriptor in it through `onFile`; anything else as it is. */
function mapped(value: unknown, onFile: (file: FileDto) => unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return TOO_DEEP;
  // a message to a model (an event's `rawPayload`): its file parts without their bytes (#899 §9)
  if (BaseMessage.isInstance(value)) return messageWithBlocks(value, blockShown);
  if (Array.isArray(value)) return value.map((item: unknown) => mapped(item, onFile, depth + 1));
  const part = partOfBlock(value);
  if (part !== undefined) return { ...partMetaOf(part) };
  if (isFileDescriptor(value)) return onFile(value);
  if (!isPlain(value)) return value;
  return rebuilt(value, (item) => mapped(item, onFile, depth + 1));
}

/** The record with each value through `change`; its symbol keys (a variant's brand) kept as they are. */
function rebuilt(value: Plain, change: (item: unknown, key: string) => unknown): Plain {
  const copy = likeOriginal(
    value,
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, change(item, key)])),
  );
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    const descriptor = definedOf(
      Object.getOwnPropertyDescriptor(value, symbol),
      // Stryker disable next-line StringLiteral: the text of an invariant that holds is never read
      "an own symbol key has a descriptor",
    );
    Object.defineProperty(copy, symbol, descriptor);
  }
  return copy;
}

/** A value of plain data with every file descriptor in it as `redactedFileOf` shows it. */
export const redactedFilesIn = (value: unknown): unknown => mapped(value, redactedFileOf);

/**
 * A value with the bytes (`inline`) of every file descriptor in it left out — what a turn keeps:
 * the descriptor otherwise whole (`fileId`, `url`, digest), so a later turn can read the file again.
 */
export const withoutInlineBytes = (value: unknown): unknown =>
  mapped(value, (file) =>
    Object.fromEntries(Object.entries(file).filter(([key]) => key !== "inline")),
  );

/** What a turn line keeps of a file: where its bytes are and what they are; the name goes through the mask. */
const KEPT_KEYS = ["mediaType", "fileId", "url", "sha256", "sizeBytes"] as const;

/** Whether a url may stay in a turn line: an `https:` url without a user or a password. */
function isKeptUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

/** The descriptor's kept fields only (never its bytes, never a key the DTO does not have). */
function keptDescriptorOf(file: FileDto): Plain | undefined {
  if (file.url !== undefined && !isKeptUrl(file.url)) return undefined;
  return Object.fromEntries(
    KEPT_KEYS.flatMap((key) => (file[key] === undefined ? [] : [[key, file[key]]])),
  );
}

/** The value with each slot (the key is this call's own nonce) back as its descriptor. */
function withFilesBack(
  value: unknown,
  slotKey: string,
  files: readonly Plain[],
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(value))
    return value.map((item: unknown) => withFilesBack(item, slotKey, files, depth + 1));
  if (!isPlain(value)) return value;
  const slot = value[slotKey];
  if (typeof slot === "number") {
    const { filename } = value;
    return { ...files[slot], ...(typeof filename === "string" ? { filename } : {}) };
  }
  return rebuilt(value, (item) => withFilesBack(item, slotKey, files, depth + 1));
}

/**
 * A value through `through` with its file descriptors held out of it and put back after: what a turn
 * line keeps of a file is `mediaType`, `fileId`, `url` (an `https:` one), digest and size — so a later
 * turn can read it again — and its name, masked with the rest. Any other key, and the bytes
 * (`inline`), are left out; a file with a url that is no `https:` one shows as `redactedFileOf`
 * shows it. The slot's key is made for this call: a value that came in cannot name it.
 */
export async function throughKeepingFiles(
  value: unknown,
  through: (rest: unknown) => Promise<unknown>,
): Promise<unknown> {
  const slotKey = `$kept-${randomUUID()}`;
  const files: Plain[] = [];
  const rest = mapped(value, (file) => {
    const kept = keptDescriptorOf(file);
    if (kept === undefined) return redactedFileOf(file);
    files.push(kept);
    return {
      [slotKey]: files.length - 1,
      ...(file.filename === undefined ? {} : { filename: file.filename }),
    };
  });
  return withFilesBack(await through(rest), slotKey, files);
}

const isFileDto = (dto: DtoClass): boolean => dto === FileDto || dto.prototype instanceof FileDto;

/** What is left of a value a file DTO's place holds that is no descriptor: nothing that carries bytes. */
const withoutSources = (value: Plain): Plain =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !(SOURCE_KEYS as readonly string[]).includes(key)),
  );

/**
 * A DTO's value with every file in it — a field of the file DTO, a nested or listed one — as
 * `redactedFileOf` shows it; the rest of the value as it is.
 */
export function scrubbedFilesOfDto(dto: DtoClass, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => scrubbedFilesOfDto(dto, item));
  if (!isPlain(value)) return value;
  if (isFileDto(dto))
    return isFileDescriptor(value) ? redactedFileOf(value) : withoutSources(value);
  const fields = new Map(fieldsOf(dto).map((field) => [field.name, field]));
  return rebuilt(value, (item, key) => {
    const element = fields.get(key)?.element;
    return element?.kind === "dto" ? scrubbedFilesOfDto(element.dto, item) : item;
  });
}
