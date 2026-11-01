/**
 * #645 — the packed packages' source maps. Vite reads every `dist/**\/*.js.map` of a core that
 * agbossTest() inlines; a map whose sources are not in the tarball prints "points to missing source
 * files" (~700 lines per `npm test` of a new project) and a stack trace names files that do not
 * exist. AC1 / AC2: every map of what `npm pack` ships names sources the tarball ships too. AC3: the
 * checks `npm run check:packed` runs on the installed project (`scripts/packed/source-maps.mjs`).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { outputOf } from "../helpers/process.js";

const repo = new URL("../../../../", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "agboss-source-maps-"));

interface CoreFrame {
  readonly frame: string;
  readonly problem: string | undefined;
}
interface SourceMaps {
  readonly missingMapSources: (packageDir: string) => readonly string[];
  readonly missingSourceWarnings: (output: string) => readonly string[];
  readonly coreFramesOf: (output: string, project: string) => readonly CoreFrame[];
}
const sourceMaps = (await import(join(repo, "scripts/packed/source-maps.mjs"))) as SourceMaps;

interface PackedFile {
  readonly path: string;
}
interface PackReport {
  readonly files: readonly PackedFile[];
}
interface SourceMap {
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
}

/** The files `npm pack` would put in the workspace's tarball, by path inside the package. */
const packedFilesOf = async (workspace: string): Promise<ReadonlySet<string>> => {
  const out = await outputOf("npm", ["pack", "--dry-run", "--json", "-w", workspace], {
    cwd: repo,
  });
  // npm 10 prints a list of reports, npm 11+ an object keyed by the package's name
  const parsed: unknown = JSON.parse(out);
  const reports: readonly PackReport[] = Array.isArray(parsed)
    ? (parsed as readonly PackReport[])
    : Object.values(parsed as Readonly<Record<string, PackReport>>);
  return new Set((reports[0]?.files ?? []).map((file) => file.path));
};

/** `<map> → <source>` for every source of a shipped map that the tarball does not ship. */
const unshippedSources = async (workspace: string, folder: string): Promise<readonly string[]> => {
  const files = await packedFilesOf(workspace);
  const maps = [...files].filter((path) => path.endsWith(".js.map"));
  expect(maps.length).toBeGreaterThan(0);
  return maps.flatMap((map) => {
    const parsed = JSON.parse(readFileSync(join(repo, folder, map), "utf8")) as SourceMap;
    return parsed.sources
      .filter((_, index) => parsed.sourcesContent?.[index] == null)
      .map((source) => normalize(join(dirname(map), source)))
      .filter((source) => !files.has(source))
      .map((source) => `${map} → ${source}`);
  });
};

/** A package folder with one map in dist/ naming `../src/x.ts`. */
const packageWithMap = (name: string, map: SourceMap, withSource: boolean): string => {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "x.js.map"), JSON.stringify({ version: 3, ...map }));
  if (withSource) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "x.ts"), "export const x = 1;\nexport const y = 2;\n");
  }
  return dir;
};

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("#645 AC1/AC2: the tarballs ship every source their maps name", () => {
  it("AC1: @agboss/core", { timeout: 60_000 }, async () => {
    expect(await unshippedSources("@agboss/core", "packages/agboss")).toEqual([]);
  });

  it("AC1: @agboss/cli", { timeout: 60_000 }, async () => {
    expect(await unshippedSources("@agboss/cli", "packages/agboss-cli")).toEqual([]);
  });
});

describe("#645 AC3: check:packed's source-map checks", () => {
  it("AC3: a map naming a source the package lacks is reported", () => {
    const dir = packageWithMap("missing", { sources: ["../src/x.ts"] }, false);

    expect(sourceMaps.missingMapSources(dir)).toEqual(["dist/x.js.map → src/x.ts"]);
  });

  it("AC3: a shipped source, or one carried in sourcesContent, is not", () => {
    const shipped = packageWithMap("shipped", { sources: ["../src/x.ts"] }, true);
    const inline = packageWithMap(
      "inline",
      { sources: ["../src/x.ts"], sourcesContent: ["export {};"] },
      false,
    );

    expect(sourceMaps.missingMapSources(shipped)).toEqual([]);
    expect(sourceMaps.missingMapSources(inline)).toEqual([]);
  });

  it("AC3: vite's warning is found in a test run's output", () => {
    const output = [
      " RUN  v4",
      'Sourcemap for "/p/node_modules/@agboss/core/dist/a.js" points to missing source files',
      " ✓ tests/a.test.ts",
    ].join("\n");

    expect(sourceMaps.missingSourceWarnings(output)).toHaveLength(1);
    expect(sourceMaps.missingSourceWarnings(" ✓ tests/a.test.ts")).toEqual([]);
  });

  it("AC2: a stack frame inside the core is checked against the installed file and its lines", () => {
    const project = join(scratch, "project");
    const core = join(project, "node_modules", "@agboss", "core", "src");
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, "x.ts"), "a\nb\nc\n");
    const output = [
      "❯ usd node_modules/@agboss/core/src/x.ts:\u001b[2m2:11\u001b[22m", // vitest colours it
      "❯ far node_modules/@agboss/core/src/x.ts:90:1",
      "❯ gone node_modules/@agboss/core/src/gone.ts:1:1",
    ].join("\n");

    expect(sourceMaps.coreFramesOf(output, project)).toEqual([
      { frame: "node_modules/@agboss/core/src/x.ts:2", problem: undefined },
      { frame: "node_modules/@agboss/core/src/x.ts:90", problem: "the file has 4 lines" },
      { frame: "node_modules/@agboss/core/src/gone.ts:1", problem: "no such file" },
    ]);
  });
});
