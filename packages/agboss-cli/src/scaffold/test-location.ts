import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path/posix";
import ts from "typescript";
import type { FileToWrite } from "./write.js";

const CONFIGS = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs"];

/** The `include` / `exclude` patterns of the project's vitest config — not those of `coverage`. */
export interface TestPatterns {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

const strings = (node: ts.Expression): string[] =>
  ts.isArrayLiteralExpression(node)
    ? node.elements.filter(ts.isStringLiteralLike).map((e) => e.text)
    : [];

const keyOf = (node: ts.Node): string | undefined =>
  ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) ? node.name.text : undefined;

/** Undefined without a vitest config: vitest's default then finds a test anywhere. */
export function testPatterns(root: string): TestPatterns | undefined {
  const config = CONFIGS.find((name) => existsSync(join(root, name)));
  if (config === undefined) return undefined;
  const text = readFileSync(join(root, config), "utf8");
  const source = ts.createSourceFile(config, text, ts.ScriptTarget.Latest, true);
  const found: { include: string[]; exclude: string[] } = { include: [], exclude: [] };
  const visit = (node: ts.Node): void => {
    const key = keyOf(node);
    if (key === "coverage") return;
    if (ts.isPropertyAssignment(node) && (key === "include" || key === "exclude"))
      found[key].push(...strings(node.initializer));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.include.length === 0 ? undefined : found;
}

/** A glob (`tests/**\/*.test.ts`, `src/{a,b}/*.ts`) as a regular expression over posix paths. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") out += "(?:";
    else if (c === "}") out += ")";
    else if (c === ",") out += "|";
    else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const matchesAny = (path: string, globs: readonly string[]): boolean =>
  globs.some((glob) => globToRegExp(glob.replace(/^\.\//, "")).test(path));

export const isFound = (path: string, patterns: TestPatterns): boolean =>
  matchesAny(path, patterns.include) && !matchesAny(path, patterns.exclude);

/** The folder a pattern's files live under: `tests/**\/*.test.ts` → `tests`. */
const baseOf = (glob: string): string =>
  glob
    .replace(/^\.\//, "")
    .split("/")
    .filter((_, i, parts) => !parts.slice(0, i + 1).some((part) => /[*?{]/.test(part)))
    .join("/");

/** Relative imports of a moved file, pointing at the same modules from its new place. */
function moveImports(file: FileToWrite, to: string): string {
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
  return source.statements
    .filter(ts.isImportDeclaration)
    .map((i) => i.moduleSpecifier)
    .filter(ts.isStringLiteral)
    .filter((s) => s.text.startsWith("."))
    .reverse()
    .reduce((text, specifier) => {
      const target = relative(dirname(to), join(dirname(file.path), specifier.text));
      const moved = target.startsWith(".") ? target : `./${target}`;
      return `${text.slice(0, specifier.getStart(source))}"${moved}"${text.slice(specifier.getEnd())}`;
    }, file.content);
}

/** The default test patterns `agboss create` writes to `vitest.config.ts` (symmetric `tests/` folder). */
export const DEFAULT_TEST_PATTERNS: TestPatterns = {
  include: ["tests/**/*.test.ts"],
  exclude: ["tests/**/*.integration.test.ts", "tests/**/*.suite.test.ts"],
};

/**
 * Places `files` according to `patterns`: a `src/<subpath>.test.ts` file moves to `tests/<subpath>.test.ts`
 * (mirroring `src/`, Spring-style), with its relative imports rewritten.
 */
export function placeTestsWithPatterns(
  patterns: TestPatterns,
  files: readonly FileToWrite[],
): FileToWrite[] {
  return files.map((file) => {
    if (!file.path.endsWith(".test.ts") || isFound(file.path, patterns)) return file;
    const rel = file.path.replace(/^src\//, "");
    const candidates = patterns.include.flatMap((glob) => [
      join(baseOf(glob), rel),
      join(baseOf(glob), basename(file.path)),
    ]);
    const to = candidates.find((path) => isFound(path, patterns));
    return to === undefined ? file : { ...file, path: to, content: moveImports(file, to) };
  });
}

/**
 * Tests go where the project's test config looks (#197): a generated `*.test.ts` its vitest config
 * would not run moves under the folder of the first pattern that finds it (`tests/`), imports rewritten.
 */
export function placeTests(root: string, files: readonly FileToWrite[]): FileToWrite[] {
  const patterns = testPatterns(root);
  return patterns === undefined ? [...files] : placeTestsWithPatterns(patterns, files);
}
