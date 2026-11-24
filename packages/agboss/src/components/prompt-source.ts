/**
 * File-first prompts (#1347): a prompt is a path to a `.prompt.md` file (`./`, `../` or `/`), an
 * `inline("…")` text, or a non-empty list of those, read in order and joined with one blank line.
 * The path form is accepted next to today's bare `prompt` text and `promptUrls` until #1347b removes
 * them, so a part that starts with `./`, `../` or `/` is a file and any other bare string is text.
 */

/** A prompt file: relative to the declaring file (`./`, `../`) or absolute (`/`). */
export type PromptFilePath = `./${string}` | `../${string}` | `/${string}`;

declare const inlinePrompt: unique symbol;

/** A prompt written in the code: `inline("…")` or `` inline`…` ``. */
export interface InlinePrompt {
  readonly [inlinePrompt]: true;
  readonly text: string;
}

/** One part of a prompt: a file or an inline text. */
export type PromptPart = PromptFilePath | InlinePrompt;

/** What `prompt` takes: one part, or a non-empty list read in order. */
export type PromptSource = PromptPart | readonly [PromptPart, ...PromptPart[]];

/** What `prompt` still takes while bare text is accepted (#1347a): a source, or text as before. */
export type PromptValue = string | InlinePrompt | readonly (string | InlinePrompt)[];

const made = new WeakSet<object>();

const make = (text: string): InlinePrompt => {
  const prompt = Object.freeze({ text }) as InlinePrompt;
  made.add(prompt);
  return prompt;
};

/** Whether a value is an `inline(…)` prompt. */
export const isInlinePrompt = (value: unknown): value is InlinePrompt =>
  typeof value === "object" && value !== null && made.has(value);

const INDENT = /^[ \t]*/;
const BLANK = /^[ \t]*$/;

/** Removes the indentation every non-blank line has in common. */
function dedent(text: string): string {
  const lines = text.split("\n");
  const indents = lines
    .filter((line) => !BLANK.test(line))
    .map((line) => INDENT.exec(line)?.[0] ?? "");
  const common = indents.reduce((least, indent) => {
    let length = 0;
    while (length < least.length && length < indent.length && least[length] === indent[length])
      length += 1;
    return least.slice(0, length);
  }, indents[0] ?? "");
  return lines.map((line) => (BLANK.test(line) ? "" : line.slice(common.length))).join("\n");
}

/**
 * A prompt written in the code. As a call it is the text as given; as a tagged template it drops the
 * indentation the lines have in common (and the blank edges, as every prompt does), so an indented
 * block reads the same as a file.
 */
export function inline(text: string): InlinePrompt;
export function inline(
  strings: TemplateStringsArray,
  ...values: readonly (string | number)[]
): InlinePrompt;
export function inline(
  first: string | TemplateStringsArray,
  ...values: readonly (string | number)[]
): InlinePrompt {
  if (typeof first === "string") return make(first);
  const text = first.reduce(
    (joined, part, index) => joined + part + (index < values.length ? String(values[index]) : ""),
    "",
  );
  return make(dedent(text));
}

const PATH_PREFIX = /^(\.\/|\.\.\/|\/)/;

/** Whether a bare string is a file path (`./`, `../`, `/`) and not prompt text. */
export const isPromptFilePath = (value: string): value is PromptFilePath =>
  PATH_PREFIX.test(value) && !value.includes("\n");

/** One part of a normalised prompt. */
export type PromptPieceOf =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "text"; readonly text: string };

const isPromptList = (value: PromptValue): value is readonly (string | InlinePrompt)[] =>
  Array.isArray(value);

/** A `prompt` as a list of files and texts, in the order written. */
export function promptPiecesOf(prompt: PromptValue | undefined): readonly PromptPieceOf[] {
  if (prompt === undefined) return [];
  const parts: readonly (string | InlinePrompt)[] = isPromptList(prompt) ? prompt : [prompt];
  return parts.flatMap((part): PromptPieceOf[] => {
    if (typeof part !== "string") return [{ kind: "text", text: part.text }];
    return isPromptFilePath(part) ? [{ kind: "file", path: part }] : [{ kind: "text", text: part }];
  });
}

/** Whether a `prompt` says anything: a file, or a text that is not empty. */
export const hasPrompt = (prompt: PromptValue | undefined): boolean =>
  promptPiecesOf(prompt).some((piece) => piece.kind === "file" || piece.text !== "");
