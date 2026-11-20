/**
 * The second stage of a file's media check (#859): its bytes are what its declared media type says
 * — an image or a PDF by its signature, a text by being valid UTF-8 (JSON by parsing as well). A
 * media type with no check of its own is taken as declared: listing it in `allowedMediaTypes` is
 * the decision to take it.
 */

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  signature.every((byte, index) => bytes[at + index] === byte);

// Stryker disable next-line StringLiteral: equivalent: the signatures are ASCII, which latin1 and utf8 spell alike
const ascii = (text: string): readonly number[] => [...Buffer.from(text, "latin1")];

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const JPEG = [0xff, 0xd8, 0xff];

const isWebp = (bytes: Uint8Array): boolean =>
  startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);

const isGif = (bytes: Uint8Array): boolean =>
  startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"));

const isMp3 = (bytes: Uint8Array): boolean =>
  startsWith(bytes, ascii("ID3")) || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);

const isWav = (bytes: Uint8Array): boolean =>
  startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WAVE"), 8);

/** An ISO base media file: `ftyp` at byte 4, its brand at 8 (`M4A ` audio; `mp4`, `isom`, `qt  ` and the like video). */
const isIsoMedia = (bytes: Uint8Array, isAudioBrand: boolean): boolean => {
  if (!startsWith(bytes, ascii("ftyp"), 4)) return false;
  const isAudio = startsWith(bytes, ascii("M4A "), 8) || startsWith(bytes, ascii("M4B "), 8);
  return isAudioBrand ? isAudio : !isAudio;
};

const isAdts = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The bytes as UTF-8 text, or `undefined` when they are not valid UTF-8. */
export function utf8Of(bytes: Uint8Array): string | undefined {
  try {
    return UTF8.decode(bytes);
  } catch {
    // not UTF-8: the answer below
  }
  return undefined;
}

const isText = (bytes: Uint8Array): boolean => utf8Of(bytes) !== undefined;

function isJson(bytes: Uint8Array): boolean {
  // Stryker disable next-line StringLiteral: equivalent: text that is none is no JSON, as `""` is none
  const text = utf8Of(bytes) ?? "";
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
  "audio/mpeg": isMp3,
  "audio/mp3": isMp3,
  "audio/wav": isWav,
  "audio/x-wav": isWav,
  "audio/ogg": (bytes) => startsWith(bytes, ascii("OggS")),
  "audio/flac": (bytes) => startsWith(bytes, ascii("fLaC")),
  "audio/aac": isAdts,
  "audio/mp4": (bytes) => isIsoMedia(bytes, true),
  "audio/m4a": (bytes) => isIsoMedia(bytes, true),
  "video/mp4": (bytes) => isIsoMedia(bytes, false),
  "video/quicktime": (bytes) => isIsoMedia(bytes, false),
  "video/webm": (bytes) => startsWith(bytes, EBML),
  "video/x-matroska": (bytes) => startsWith(bytes, EBML),
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
