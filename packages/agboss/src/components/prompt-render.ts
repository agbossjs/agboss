import fs from "node:fs/promises";
import path from "node:path";
import type { PromptOptions } from "./prompt-options.js";
import { renderTemplate } from "./render-template.js";
import { ComponentError } from "./metadata.js";
import {
  displayPath,
  inputInInstructions,
  pathAsText,
  PromptError,
  unknownVariables,
  type PromptProblem,
} from "./prompt-problems.js";

const BOM = /^\uFEFF/;
const LINE_BREAK = /\r\n?/g;
const BLANK_LINE = /^[ \t]*$/;

/**
 * A prompt as it is sent and fingerprinted (#120): BOM removed, line breaks as `\n`, Unicode NFC,
 * blank lines at the edges removed. Kept as written: indentation, spaces inside a line, tabs, blank
 * lines between paragraphs.
 */
export function normalisePromptText(text: string): string {
  const lines = text.replace(BOM, "").replace(LINE_BREAK, "\n").normalize("NFC").split("\n");
  const first = lines.findIndex((line) => !BLANK_LINE.test(line));
  if (first === -1) return "";
  const last = lines.findLastIndex((line) => !BLANK_LINE.test(line));
  return lines.slice(first, last + 1).join("\n");
}

/** Parts of one prompt (inline `prompt` first, then files in order), joined with one blank line. */
const joinPromptParts = (parts: readonly string[]): string =>
  parts
    .map(normalisePromptText)
    .filter((part) => part !== "")
    .join("\n\n");

/** The text of a prompt input (an assembled prompt, a profile's override), if it is one. */
export const promptTextOf = (input: unknown): string | undefined =>
  typeof input === "string" ? input : undefined;

/** Whose prompt it is (`@Agent "scout"`), its options and the file it is declared in. */
export interface PromptOwner {
  readonly label: string;
  readonly options: PromptOptions | undefined;
  readonly source: string | undefined;
  /** The owner's own variables, over the loader's (the workflow's). */
  readonly variables?: Readonly<Record<string, unknown>>;
}

interface Segment {
  readonly where: string;
  readonly text: string;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EISDIR");

/**
 * Reads and checks every prompt of a workflow at assembly — files read eagerly, every `{{var}}`
 * checked against the static variables, `{{input.…}}` refused (#270 Q51: instructions are static,
 * the same bytes in every execution) — and collects the problems to report them all at once.
 */
export class PromptLoader {
  readonly #problems: PromptProblem[] = [];
  readonly #variables: Readonly<Record<string, unknown>>;

  constructor(variables: Readonly<Record<string, unknown>> = {}) {
    this.#variables = variables;
  }

  /** The owner's prompt as its static text; problems are kept for `throwIfAny`. */
  async load(owner: PromptOwner): Promise<string> {
    const variables = { ...this.#variables, ...(owner.variables ?? {}) };
    const known = Object.keys(variables);
    const segments = await this.#segments(owner);
    const before = this.#problems.length;
    segments.forEach((segment) => {
      this.#problems.push(...inputInInstructions(segment.where, segment.text));
      this.#problems.push(...unknownVariables(segment.where, segment.text, known));
    });
    const template = joinPromptParts(segments.map((segment) => segment.text));
    if (this.#problems.length > before) return template;
    const unknown = (key: string) =>
      new ComponentError(`${owner.label}: unknown prompt variable {{${key}}}`);
    return normalisePromptText(renderTemplate(template, variables, unknown));
  }

  /** Throws `PromptError` with every problem found so far. */
  throwIfAny(): void {
    if (this.#problems.length > 0) throw new PromptError(this.#problems);
  }

  async #segments(owner: PromptOwner): Promise<Segment[]> {
    const { options, source, label } = owner;
    if (options === undefined) return [];
    this.#problems.push(...pathAsText(label, options.prompt));
    const inline = options.prompt ? [{ where: `${label} prompt`, text: options.prompt }] : [];
    const urls = options.promptUrls ?? [];
    if (urls.length === 0) return inline;
    if (source === undefined) {
      const message = `${label}: cannot resolve promptUrls — the declaring file is unknown`;
      this.#problems.push({ code: "prompt.missing-file", message });
      return inline;
    }
    const files = await Promise.all(
      urls.map((url) => this.#read(label, path.resolve(path.dirname(source), url))),
    );
    return [...inline, ...files.filter((file): file is Segment => file !== undefined)];
  }

  async #read(label: string, file: string): Promise<Segment | undefined> {
    try {
      return { where: displayPath(file), text: await fs.readFile(file, "utf-8") };
    } catch (error) {
      if (!isMissing(error)) throw error;
      const message = `${displayPath(file)} (promptUrls of ${label}) does not exist`;
      this.#problems.push({ code: "prompt.missing-file", message });
      return undefined;
    }
  }
}
