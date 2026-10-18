import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spike #115 — prompt text as the model receives it.
 *
 * The normalisation is applied when the prompt is LOADED, and the loaded text is what is both
 * sent and hashed. Normalising only inside the hash would let two different requests share a
 * fingerprint (CRLF sent to the model, LF hashed).
 */

/** Prompt text after normalisation — the only form that is sent or hashed. */
export type PromptText = string & { readonly __prompt: true };

/** Where `promptUrls` resolve from: the component's file (`import.meta.url`) or its folder. */
export type ComponentLocation = string;

/** U+FEFF — written by some Windows editors at the start of a UTF-8 file. */
export const BOM = String.fromCharCode(0xfeff);
const LINE_BREAK = /\r\n?/g;
const TRAILING_BLANKS = /[ \t]+$/gm;
const EDGE_BLANK_LINES = /^\n+|\n+$/g;

/**
 * BOM removed, CRLF / CR → LF, trailing spaces and tabs removed from every line, blank lines at
 * the start and end removed, Unicode NFC. Indentation, inner spaces and blank lines between
 * paragraphs are kept: the model sees them.
 */
export function normalizePrompt(raw: string): PromptText {
  const text = raw
    .replace(new RegExp(`^${BOM}`), "")
    .replace(LINE_BREAK, "\n")
    .replace(TRAILING_BLANKS, "")
    .replace(EDGE_BLANK_LINES, "")
    .normalize("NFC");
  return text as PromptText; // branded at the one place a prompt is produced
}

/** Parts of one prompt (inline `prompt` + files of `promptUrls`) are joined by one blank line. */
export const joinPromptParts = (parts: readonly string[]): PromptText =>
  normalizePrompt(
    parts
      .map(normalizePrompt)
      .filter((part) => part.length > 0)
      .join("\n\n"),
  );

function baseDirectory(location: ComponentLocation): string {
  return location.startsWith("file:") ? dirname(fileURLToPath(location)) : location;
}

/** Reads `promptUrls` relative to the component (like Angular `styleUrls`), in the given order. */
export async function loadPrompt(
  location: ComponentLocation,
  promptUrls: readonly string[],
  inline?: string,
): Promise<PromptText> {
  const dir = baseDirectory(location);
  const files = await Promise.all(promptUrls.map((url) => readFile(resolve(dir, url), "utf8")));
  return joinPromptParts([...(inline === undefined ? [] : [inline]), ...files]);
}
