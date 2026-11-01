// Source maps of an installed package (#645): every `dist/**/*.js.map` names sources that exist in the
// package (or carries their text), so vite — which reads them once AGBoss is inlined by agbossTest() —
// prints no "points to missing source files", and a stack trace inside the core names a line that is
// there to open.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** What vite prints for a map whose sources it cannot read. */
export const MISSING_SOURCES_WARNING = "points to missing source files";

const mapsUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js.map"))
    .map((entry) => join(entry.parentPath, entry.name));

/** The sources of one map that neither exist next to it nor are carried in its `sourcesContent`. */
const missingOf = (packageDir, map) => {
  const parsed = JSON.parse(readFileSync(map, "utf8"));
  const root = resolve(dirname(map), parsed.sourceRoot ?? "");
  return (parsed.sources ?? [])
    .filter((source, index) => parsed.sourcesContent?.[index] == null)
    .map((source) => resolve(root, source))
    .filter((source) => !existsSync(source))
    .map((source) => `${relative(packageDir, map)} → ${relative(packageDir, source)}`);
};

/** Every `<map> → <source>` of the package's `dist/` whose source is missing; empty when none is. */
export function missingMapSources(packageDir) {
  const dist = join(packageDir, "dist");
  if (!existsSync(dist)) return [];
  return mapsUnder(dist).flatMap((map) => missingOf(packageDir, map));
}

/** The lines of a test run's output with vite's missing-sources warning. */
export const missingSourceWarnings = (output) =>
  output.split("\n").filter((line) => line.includes(MISSING_SOURCES_WARNING));

/** The colour sequences of a terminal: ESC, `[`, numbers, `m`. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
/** A run's output without colours: vitest colours its stack traces even when piped. */
const plain = (output) => output.replaceAll(ANSI, "");

const FRAME = /(node_modules\/@agboss\/core\/[^\s:()]+):(\d+):\d+/g;

/**
 * The frames of a stack trace printed in `project` that point inside the installed core, each with why
 * it cannot be opened (`undefined` when its file has that line).
 */
export function coreFramesOf(output, project) {
  return [...plain(output).matchAll(FRAME)].map(([, file, line]) => {
    const path = join(project, file);
    if (!existsSync(path)) return { frame: `${file}:${line}`, problem: "no such file" };
    const lines = readFileSync(path, "utf8").split("\n").length;
    const problem = Number(line) > lines ? `the file has ${lines} lines` : undefined;
    return { frame: `${file}:${line}`, problem };
  });
}
