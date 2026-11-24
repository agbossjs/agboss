import { readFileSync } from "node:fs";
import { spanText, type LabeledSpan, type SourceSpan } from "./source-span.js";

/**
 * A `rustc`-style diagnostic (#1325c): a header, a primary span and secondary spans over the user's
 * own source, `= note:` and `= help:` lines. Everything it prints comes from the rule's own words and
 * the user's source files — never from the run's data.
 */
export interface Diagnostic {
  /** `input.outdated-on-path`. */
  readonly code: string;
  readonly message: string;
  /** `^^^` under the place the rule is broken at. */
  readonly primary?: LabeledSpan;
  /** `---` under the places that explain it. */
  readonly secondary?: readonly LabeledSpan[];
  readonly notes?: readonly string[];
  readonly help?: string;
  /** Lines shown under `help`, as written (`26 |       .toAgent(A)` / `27 +       .toAgent(B)`). */
  readonly patch?: string;
}

export interface RenderOptions {
  /** The text of a file, or `undefined` when it cannot be read: the snippet is left out. Default: the file system. */
  readonly readSource?: (file: string) => string | undefined;
  /** Paths are shown relative to it. Default: the working directory. */
  readonly cwd?: string;
  /** Adds `For more information about this error, try \`agboss explain <code>\`.` */
  readonly explainHint?: boolean;
}

const readFromDisk = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** A span with the mark it is drawn with: `^` for the primary, `-` for the others. */
type MarkedSpan = LabeledSpan & { readonly mark: "^" | "-" };

/** One underline in a line: where it starts, how long, its mark and its words. */
interface Mark {
  readonly column: number;
  readonly length: number;
  readonly mark: "^" | "-";
  readonly label: string;
}

const TAB_WIDTH = 4;

/** A source line with tabs as spaces, and where a 1-based column of the original lands (0-based). */
function expandTabs(line: string): {
  readonly text: string;
  readonly at: (column: number) => number;
} {
  const starts: number[] = [];
  let text = "";
  for (const char of line) {
    starts.push(text.length);
    text += char === "\t" ? " ".repeat(TAB_WIDTH) : char;
  }
  return { text, at: (column) => starts[column - 1] ?? text.length };
}

const IDENTIFIER = /^[\w$.]+/u;

/** How far past `from` the parenthesis opened at `rest[from]` closes on this line; `undefined` when it does not. */
function closingOf(rest: string, from: number): number | undefined {
  let depth = 0;
  for (let index = from; index < rest.length; index += 1) {
    if (rest[index] === "(") depth += 1;
    if (rest[index] === ")") depth -= 1;
    if (depth === 0) return index + 1;
  }
  return undefined;
}

/** The end (exclusive, 1-based) of what a span underlines in `line`: its `endColumn`, a call to its `)`, else its token. */
function endColumnOf(span: SourceSpan, line: string): number {
  if (span.endColumn !== undefined && span.endColumn > span.column) return span.endColumn;
  const rest = line.slice(span.column - 1);
  const token = IDENTIFIER.exec(rest)?.[0] ?? "";
  const call = rest[token.length] === "(" ? closingOf(rest, token.length) : undefined;
  return span.column + (call ?? Math.max(token.length, 1));
}

/** The underline rows of a line's marks: the rightmost label on the first row, the others below, right to left. */
function underlineRows(marks: readonly Mark[]): readonly string[] {
  const ordered = [...marks].sort((a, b) => a.column - b.column);
  const drawn = ordered.reduce(
    (row, { column, length, mark }) => row.padEnd(column, " ") + mark.repeat(length),
    "",
  );
  const last = ordered[ordered.length - 1];
  if (last === undefined) return [];
  const rows = [`${drawn}${last.label === "" ? "" : ` ${last.label}`}`];
  const rest = ordered.slice(0, -1);
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const pipes = rest
      .slice(0, index + 1)
      .reduce((row, { column }) => row.padEnd(column, " ") + "|", "");
    const target = rest[index];
    if (target === undefined) continue;
    rows.push(pipes, `${pipes.slice(0, target.column)}${target.label}`);
  }
  return rows;
}

/** The lines of the snippet: each line with a span, the marks under it, `...` for a gap. */
function snippetLines(
  spans: readonly MarkedSpan[],
  text: string,
  gutter: number,
): readonly string[] {
  const source = text.split("\n");
  const lines = [...new Set(spans.map(({ span }) => span.line))].sort((a, b) => a - b);
  const out: string[] = [`${" ".repeat(gutter)} |`];
  let previous: number | undefined;
  for (const line of lines) {
    const raw = source[line - 1];
    if (raw === undefined) continue;
    if (previous !== undefined && line - previous === 2)
      out.push(`${String(line - 1).padStart(gutter)} | ${expandTabs(source[line - 2] ?? "").text}`);
    else if (previous !== undefined && line - previous > 2) out.push("...");
    const { text: shown, at } = expandTabs(raw);
    out.push(`${String(line).padStart(gutter)} | ${shown}`);
    const marks = spans
      .filter(({ span }) => span.line === line)
      .map(({ span, label, mark }): Mark => {
        const start = at(span.column);
        const end = at(endColumnOf(span, raw));
        return { column: start, length: Math.max(end - start, 1), mark, label };
      });
    out.push(...underlineRows(marks).map((row) => `${" ".repeat(gutter)} | ${row}`));
    previous = line;
  }
  return out;
}

/** The marks of a diagnostic: its primary span, then the secondary spans of the same file. */
function marksOf(diagnostic: Diagnostic): readonly MarkedSpan[] {
  const { primary, secondary = [] } = diagnostic;
  if (primary === undefined) return [];
  return [
    { ...primary, mark: "^" },
    ...secondary
      .filter(({ span }) => span.file === primary.span.file)
      .map((labeled): MarkedSpan => ({ ...labeled, mark: "-" })),
  ];
}

/** The lines under the snippet: `= note:`, `= help:`, the patch. */
function footerLines(diagnostic: Diagnostic, pad: string, hasSnippet: boolean): readonly string[] {
  const { notes = [], help, patch } = diagnostic;
  return [
    ...(hasSnippet && (notes.length > 0 || help !== undefined) ? [`${pad} |`] : []),
    ...notes.map((note) => `${pad} = note: ${note}`),
    ...(help === undefined ? [] : [`${pad} = help: ${help}`]),
    ...(patch === undefined ? [] : [`${pad} |`, ...patch.split("\n")]),
  ];
}

/**
 * The diagnostic as text, in the shape `rustc` prints:
 *
 *     error[input.outdated-on-path]: message
 *       --> src/offer.workflow.ts:27:8
 *        |
 *     22 |       .toAgent(OfferAgent)
 *        |        ------------------ first produced here
 *
 * Spans whose file cannot be read keep their `-->` line and lose the snippet. Only the primary span's
 * file is quoted: a secondary span in another file is named, not shown.
 */
export function renderDiagnostic(diagnostic: Diagnostic, options: RenderOptions = {}): string {
  const { readSource = readFromDisk, cwd = process.cwd() } = options;
  const { code, message, primary, secondary = [] } = diagnostic;
  const text = primary === undefined ? undefined : readSource(primary.span.file);
  const marks = marksOf(diagnostic);
  const gutter = Math.max(1, ...marks.map(({ span }) => String(span.line).length));
  const pad = " ".repeat(gutter);
  const out = [`error[${code}]: ${message}`];
  if (primary !== undefined) out.push(`${pad}--> ${spanText(primary.span, cwd)}`);
  if (text !== undefined) out.push(...snippetLines(marks, text, gutter));
  for (const other of secondary.filter(({ span }) => span.file !== primary?.span.file))
    out.push(`${pad}::: ${spanText(other.span, cwd)} ${other.label}`);
  out.push(...footerLines(diagnostic, pad, text !== undefined));
  if (options.explainHint === true)
    out.push("", `For more information about this error, try \`agboss explain ${code}\`.`);
  return out.join("\n");
}
