import { Buffer } from "node:buffer";
import { truncatedResultMarker } from "../../prompts/agents.js";
import type { Bytes } from "../../units/index.js";

/**
 * The bound on what a model reads of one tool result (#336): a rendered result — a tool's, an MCP
 * tool's, a knowledge base's, an error's — longer than its `maxResultSize` in bytes of UTF-8 is cut
 * before PII masking, at the last whitespace within the final 256 bytes it keeps (else at the bound,
 * never inside a character), and ends with the marker that says how much was dropped. Loaded with
 * the first result (the root import stays lean, #205).
 */

/** How far back from the bound a cut looks for whitespace. */
const WHITESPACE_WINDOW = 256;

/** Space, tab, line feed and carriage return: where a cut may fall. */
const WHITESPACE: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** A text within its bound: whole, or its first part and the marker that follows it. */
export interface BoundedText {
  /** The text itself, or the part of it that was kept. */
  readonly kept: string;
  /** What follows the kept part — the truncation marker; empty when the text is whole. */
  readonly marker: string;
  readonly isTruncated: boolean;
}

/** A byte inside a UTF-8 character (`10xxxxxx`): a cut before it would split the character. */
const isContinuationByte = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 0x80 && byte < 0xc0;

/** Where the kept bytes end: at the bound, moved back to a character's start, then to whitespace. */
function cutPoint(bytes: Buffer, maxResultSize: number): number {
  let end = maxResultSize;
  while (end > 0 && isContinuationByte(bytes[end])) end -= 1;
  const from = Math.max(1, end - WHITESPACE_WINDOW);
  for (let index = end - 1; index >= from; index -= 1) {
    if (WHITESPACE.has(bytes[index] ?? 0)) return index;
  }
  return end;
}

/** The text cut to `maxResultSize` bytes of UTF-8, with the marker; as it is when it fits. */
export function boundedText(text: string, maxResultSize: Bytes): BoundedText {
  const size = Buffer.byteLength(text, "utf8");
  if (size <= maxResultSize) return { kept: text, marker: "", isTruncated: false };
  const bytes = Buffer.from(text, "utf8");
  const kept = bytes.subarray(0, cutPoint(bytes, maxResultSize));
  return {
    kept: kept.toString("utf8"),
    marker: truncatedResultMarker(size, kept.length),
    isTruncated: true,
  };
}
