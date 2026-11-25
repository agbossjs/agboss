import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * What each assembly rule and `agboss check` code means and how to fix it (#1325c): the rows of the
 * skills' catalog (`skills/agboss/references/11-cli-studio-and-error-catalog.md`, shipped with the
 * package), read when a code is explained — the catalog is the one place these words are written, so
 * `agboss explain`, the snippet's `= note:` and the skills never say different things.
 */
export interface RuleExplanation {
  /** What the rule found. */
  readonly means: string;
  /** `before → after`: how to write it instead; absent when the catalog gives none. */
  readonly fix?: string;
}

/** The catalog, from `src/core/diagnostics` or `dist/core/diagnostics` up to the package's `skills/`. */
const CATALOG = fileURLToPath(
  new URL("../../../skills/agboss/references/11-cli-studio-and-error-catalog.md", import.meta.url),
);

/** `| \`[code]\` | means | before → after |` */
const ROW = /^\|\s*`\[([a-z0-9.-]+)\]`\s*\|(.*)\|\s*$/u;

/** The cells of a row: an escaped `\|` is a pipe inside a cell. */
const cellsOf = (rest: string): readonly string[] =>
  rest.split(/(?<!\\)\|/u).map((cell) => cell.trim().replaceAll("\\|", "|"));

/** The catalog's rows by code; the first row of a code wins. Empty when the package ships no catalog. */
export function parseRuleCatalog(markdown: string): ReadonlyMap<string, RuleExplanation> {
  const rows = new Map<string, RuleExplanation>();
  for (const line of markdown.split("\n")) {
    const row = ROW.exec(line);
    const code = row?.[1];
    if (row === null || code === undefined || rows.has(code)) continue;
    const [means = "", fix = ""] = cellsOf(row[2] ?? "");
    rows.set(code, fix === "" ? { means } : { means, fix });
  }
  return rows;
}

let catalog: ReadonlyMap<string, RuleExplanation> | undefined;

function loadedCatalog(): ReadonlyMap<string, RuleExplanation> {
  if (catalog !== undefined) return catalog;
  try {
    catalog = parseRuleCatalog(readFileSync(CATALOG, "utf8"));
  } catch {
    // a package without its skills explains nothing: a diagnostic is drawn without the words
    catalog = new Map();
  }
  return catalog;
}

/** What the catalog says of a rule or check code; `undefined` for a code it does not list. */
export const ruleExplanationOf = (code: string): RuleExplanation | undefined =>
  loadedCatalog().get(code);

/** Every code the catalog lists, in its order. */
export const explainedRuleCodes = (): readonly string[] => [...loadedCatalog().keys()];
