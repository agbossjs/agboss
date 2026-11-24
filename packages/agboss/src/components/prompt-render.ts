import fs from "node:fs/promises";
import path from "node:path";
import type { PromptOptions } from "./prompt-options.js";
import { promptPiecesOf } from "./prompt-source.js";
import { renderTemplate } from "./render-template.js";
import { ComponentError } from "./metadata.js";
import {
  displayPath,
  bareText,
  inputInInstructions,
  pathAsText,
  PromptError,
  unknownVariables,
  unusedVariables,
  type PromptProblem,
} from "./prompt-problems.js";
import { resolvedPromptVariables, type ResolvedPromptVariables } from "./prompt-variables.js";

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
  /** The owner's own variables (`promptVariables`: texts or `env(…)` references), over the loader's. */
  readonly variables?: Readonly<Record<string, unknown>> | undefined;
  /** What the variables' problems name when one owner loads several texts (a router's routes); default `label`. */
  readonly variablesLabel?: string;
}

/** The variables of one owner across its loads: which keys its texts use. */
interface VariableUse {
  readonly where: string;
  readonly keys: readonly string[];
  readonly texts: string[];
}

/** What a loader reads variables with: the application's level, and the process environment. */
export interface PromptLoaderOptions {
  /** `@Application({ promptVariables })`: under the workflow's. */
  readonly application?: Readonly<Record<string, unknown>> | undefined;
  /** Where `env(…)` references are read from; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
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
  readonly #variables: ResolvedPromptVariables;
  readonly #env: NodeJS.ProcessEnv;
  /** Whether a level above a component has a problem: nothing is rendered then. */
  readonly #isBroken: boolean;
  readonly #uses = new Map<object, VariableUse>();

  /**
   * `variables` are the workflow's `promptVariables` over `options.application`'s; every
   * `env(…)` reference is read from `options.env` here, a secret reference is a problem
   * (`prompt.secret-in-instructions`) and no text is rendered while any variable has a problem.
   */
  constructor(
    variables: Readonly<Record<string, unknown>> = {},
    options: PromptLoaderOptions = {},
  ) {
    this.#env = options.env ?? process.env;
    const application = resolvedPromptVariables(
      "@Application promptVariables",
      options.application,
      this.#env,
      this.#problems,
    );
    const workflow = resolvedPromptVariables(
      "@Workflow promptVariables",
      variables,
      this.#env,
      this.#problems,
    );
    this.#variables = { ...application, ...workflow };
    this.#isBroken = this.#problems.length > 0;
  }

  /** The owner's prompt as its static text; problems are kept for `throwIfAny`. */
  async load(owner: PromptOwner): Promise<string> {
    const before = this.#problems.length;
    const own = resolvedPromptVariables(
      `${owner.variablesLabel ?? owner.label} promptVariables`,
      owner.variables,
      this.#env,
      this.#problems,
    );
    const variables = { ...this.#variables, ...own };
    const known = Object.keys(variables);
    const segments = await this.#segments(owner);
    this.#noteUse(owner, segments);
    segments.forEach((segment) => {
      this.#problems.push(...inputInInstructions(segment.where, segment.text));
      this.#problems.push(...unknownVariables(segment.where, segment.text, known));
    });
    const template = joinPromptParts(segments.map((segment) => segment.text));
    if (this.#isBroken || this.#problems.length > before) return template;
    const unknown = (key: string) =>
      new ComponentError({ message: `${owner.label}: unknown prompt variable {{${key}}}` });
    return normalisePromptText(renderTemplate(template, variables, unknown));
  }

  /** The loader of a workflow's prompts: its `promptVariables` over its application's (`owner`). */
  static of(
    workflow: { readonly promptVariables?: Readonly<Record<string, unknown>> | undefined },
    owner: { readonly promptVariables?: Readonly<Record<string, unknown>> | undefined } | undefined,
    env: NodeJS.ProcessEnv,
  ): PromptLoader {
    return new PromptLoader(workflow.promptVariables ?? {}, {
      application: owner?.promptVariables,
      env,
    });
  }

  /** Remembers which keys of an owner's own variables its texts use; checked in `throwIfAny`. */
  #noteUse(owner: PromptOwner, segments: readonly Segment[]): void {
    const { variables } = owner;
    if (variables === undefined || Object.keys(variables).length === 0) return;
    const use = this.#uses.get(variables) ?? {
      where: owner.variablesLabel ?? owner.label,
      keys: Object.keys(variables),
      texts: [],
    };
    use.texts.push(...segments.map((segment) => segment.text));
    this.#uses.set(variables, use);
  }

  /** Throws `PromptError` with every problem found so far, the component keys no prompt uses included. */
  throwIfAny(): void {
    for (const use of this.#uses.values())
      this.#problems.push(...unusedVariables(use.where, use.keys, use.texts));
    this.#uses.clear();
    if (this.#problems.length > 0) throw new PromptError({ problems: this.#problems });
  }

  async #segments(owner: PromptOwner): Promise<Segment[]> {
    const { options, source, label } = owner;
    if (options === undefined) return [];
    const pieces = promptPiecesOf(options.prompt);
    const all = pieces.map((piece) =>
      piece.kind === "file" ? { ...piece, via: "prompt" } : piece,
    );
    const segments = await Promise.all(
      all.map(async (piece): Promise<Segment | undefined> => {
        if (piece.kind === "bare") {
          this.#problems.push(...bareText(label, piece.text));
          return undefined;
        }
        if (piece.kind === "text") {
          this.#problems.push(...pathAsText(label, piece.text));
          return piece.text === "" ? undefined : { where: `${label} prompt`, text: piece.text };
        }
        if (source === undefined) {
          const message = `${label}: cannot resolve ${piece.via} — the declaring file is unknown`;
          this.#problems.push({ code: "prompt.missing-file", message });
          return undefined;
        }
        return this.#read(label, path.resolve(path.dirname(source), piece.path), piece.via);
      }),
    );
    return segments.filter((segment): segment is Segment => segment !== undefined);
  }

  async #read(label: string, file: string, via: string): Promise<Segment | undefined> {
    try {
      return { where: displayPath(file), text: await fs.readFile(file, "utf-8") };
    } catch (error) {
      if (!isMissing(error)) throw error;
      const message = `${displayPath(file)} (${via} of ${label}) does not exist`;
      this.#problems.push({ code: "prompt.missing-file", message });
      return undefined;
    }
  }
}
