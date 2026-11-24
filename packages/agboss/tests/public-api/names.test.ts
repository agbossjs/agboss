/**
 * #195 AC2: one name per meaning — a public name exported by several entries is the same declaration
 * everywhere. The entries come from package.json#exports (minus `deprecatedExports`, the old entries
 * kept one minor release, which must re-export only what the root entry has).
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const pkgDir = new URL("../../", import.meta.url);
const Package = z.object({
  exports: z.record(z.string(), z.object({ types: z.string() })),
  deprecatedExports: z.record(z.string(), z.string()),
});
const pkg = Package.parse(JSON.parse(readFileSync(new URL("package.json", pkgDir), "utf8")));

/** `./dist/dto/index.d.ts` → the source file it is built from. */
const sourceOf = (types: string): string =>
  new URL(types.replace("./dist/", "src/").replace(/\.d\.ts$/, ".ts"), pkgDir).pathname;

const entries = Object.entries(pkg.exports).map(([subpath, { types }]) => ({
  subpath,
  file: sourceOf(types),
  deprecated: subpath in pkg.deprecatedExports,
}));
const program = ts.createProgram(
  entries.map((entry) => entry.file),
  {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    strict: true,
  },
);
const checker = program.getTypeChecker();

/** Each exported name of the entry → the declaration it stands for (`file#name`). */
function surfaceOf(file: string): Map<string, string> {
  const source = program.getSourceFile(file);
  const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (module === undefined) throw new Error(`not a module: ${file}`);
  return new Map(
    checker.getExportsOfModule(module).map((symbol) => {
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const declaration = target.declarations?.[0];
      const where = declaration?.getSourceFile().fileName.replace(/.*\/src\//, "") ?? "?";
      return [symbol.name, `${where}#${target.name}`];
    }),
  );
}

const surfaces = new Map(entries.map((entry) => [entry.subpath, surfaceOf(entry.file)]));

describe("public names (#195)", () => {
  it("AC2: a name means one thing across all current entries", () => {
    const meanings = new Map<string, Set<string>>();
    for (const entry of entries.filter((e) => !e.deprecated)) {
      for (const [name, declaration] of surfaces.get(entry.subpath) ?? []) {
        meanings.set(name, (meanings.get(name) ?? new Set()).add(declaration));
      }
    }
    const ambiguous = [...meanings].filter(([, declarations]) => declarations.size > 1);

    expect(meanings.size).toBeGreaterThan(400);
    expect(ambiguous).toEqual([]);
  });

  it("no deprecated entry is left (#1324d): the root's one renamed name stays its own", () => {
    const root = surfaces.get(".") ?? new Map<string, string>();

    expect(pkg.deprecatedExports).toEqual({});
    expect(root.has("RouterEngine")).toBe(false); // internal since #1313
    expect(root.get("Router")).toBe("flow/decorators/router.ts#Router");
  });
});
