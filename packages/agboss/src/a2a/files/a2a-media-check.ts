/**
 * The second stage of a file's media check (#859): its bytes are what its declared media type says
 * — an image or a PDF by its signature, a text by being valid UTF-8 (JSON by parsing as well). A
 * media type with no check of its own is taken as declared: listing it in `allowedMediaTypes` is
 * the decision to take it.
 */

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  bytes.length >= at + signature.length &&
  signature.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string): readonly number[] => [...Buffer.from(text, "latin1")];

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

const isWebp = (bytes: Uint8Array): boolean =>
  startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);

const isGif = (bytes: Uint8Array): boolean =>
  startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"));

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The bytes as UTF-8 text, or `undefined` when they are not valid UTF-8. */
export function utf8Of(bytes: Uint8Array): string | undefined {
  try {
    return UTF8.decode(bytes);
  } catch {
    return undefined; // not UTF-8
  }
}

const isText = (bytes: Uint8Array): boolean => utf8Of(bytes) !== undefined;

function isJson(bytes: Uint8Array): boolean {
  const text = utf8Of(bytes);
  if (text === undefined) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false; // not JSON
  }
}

/** Each checked media type and what its bytes must be. */
const CHECKS: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  "image/png": (bytes) => startsWith(bytes, PNG),
  "image/jpeg": (bytes) => startsWith(bytes, JPEG),
  "image/webp": isWebp,
  "image/gif": isGif,
  "application/pdf": (bytes) => startsWith(bytes, ascii("%PDF-")),
  "text/plain": isText,
  "text/markdown": isText,
  "text/csv": isText,
  "application/json": isJson,
};

/** Whether the bytes are what `mediaType` (an essence) says; `true` for a type with no check. */
export function isOfMediaType(mediaType: string, bytes: Uint8Array): boolean {
  const check = Object.hasOwn(CHECKS, mediaType) ? CHECKS[mediaType] : undefined;
  return check === undefined || check(bytes);
}
