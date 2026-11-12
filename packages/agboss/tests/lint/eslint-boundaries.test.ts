/**
 * #906 D2: the module-isolation and index-only import rules of eslint.config.js name `src/<module>`
 * paths. A module renamed (`terns` → `turns`) left three of them matching nothing, silently. So:
 * every path the boundary config names must exist, and a planted bad import must still be refused.
 */
import { existsSync, globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TSESLint } from "@typescript-eslint/utils";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const srcDir = resolve(root, "packages/agboss/src");

interface ConfigObject {
  readonly files?: readonly string[];
  readonly ignores?: readonly string[];
  readonly rules?: Readonly<Record<string, unknown>>;
}

const loaded = (await import(pathToFileURL(resolve(root, "eslint.config.js")).href)) as {
  readonly default: readonly ConfigObject[];
};
const boundaries = loaded.default.filter(
  (entry) => entry.rules?.["no-restricted-imports"] !== undefined,
);

/** The restricted-import patterns' regexes of every boundary rule. */
const regexes = boundaries.flatMap((entry) => {
  const options = (
    entry.rules?.["no-restricted-imports"] as readonly [
      unknown,
      { patterns: readonly { regex: string }[] },
    ]
  )[1];
  return options.patterns.map((pattern) => pattern.regex);
});

describe("#906 D2: the eslint boundary config names modules that exist", () => {
  it("has boundary rules at all (a config that loses them fails here)", () => {
    expect(boundaries.length).toBeGreaterThanOrEqual(6);
  });

  it("every `files` and `ignores` glob of a boundary rule under packages/ matches a file", () => {
    const globs = boundaries
      .flatMap((entry) => [...(entry.files ?? []), ...(entry.ignores ?? [])])
      .filter((glob) => glob.startsWith("packages/") || glob.startsWith("examples/"));
    const empty = globs.filter((glob) => globSync(glob, { cwd: root }).length === 0);
    expect(globs.length).toBeGreaterThan(8);
    expect(empty).toEqual([]);
  });

  it("every module a restricted-import regex names is a directory of src", () => {
    const names = regexes.flatMap((regex) => {
      const group = /^\/\(?([a-z|-]+)\)?\//.exec(regex)?.[1];
      return group === undefined ? [] : group.split("|");
    });
    const missing = [...new Set(names)].filter((name) => !existsSync(resolve(srcDir, name)));
    expect(names).toEqual(expect.arrayContaining(["routers", "tools", "turns", "graph"]));
    expect(missing).toEqual([]);
  });
});

describe("#906 D2: the isolation rules refuse a planted bad import", () => {
  const linter = new TSESLint.Linter({ configType: "flat" });
  const configs = boundaries.map((entry) => ({
    ...entry,
    languageOptions: { parser: tseslint.parser },
  })) as TSESLint.FlatConfig.ConfigArray;
  const refused = (code: string, file: string): readonly string[] =>
    linter
      .verify(code, configs, file)
      .filter((message) => message.ruleId === "no-restricted-imports")
      .map((message) => message.message);

  it("a module of src reaches into turns only through its index", () => {
    expect(
      refused('import { x } from "../turns/sqlite-store.js";', "packages/agboss/src/run/probe.ts"),
    ).toEqual([expect.stringContaining("Import turns only through src/turns/index.ts")]);
    expect(
      refused('import { x } from "../turns/index.js";', "packages/agboss/src/run/probe.ts"),
    ).toEqual([]);
  });

  it("turns depend on nothing else in src", () => {
    expect(
      refused(
        'import { AGBossError } from "../core/errors.js";',
        "packages/agboss/src/turns/probe.ts",
      ),
    ).toEqual([expect.stringContaining("Turns are isolated")]);
  });

  it("routers and tools stay isolated, and reach each other through the index only", () => {
    expect(
      refused('import { x } from "../graph/limits.js";', "packages/agboss/src/routers/probe.ts"),
    ).toEqual([expect.stringContaining("Routers are isolated")]);
    expect(
      refused('import { x } from "../routers/other.js";', "packages/agboss/src/tools/probe.ts"),
    ).not.toEqual([]);
    expect(
      refused('import { x } from "../tools/define-tool.js";', "packages/agboss/src/run/probe.ts"),
    ).toEqual([expect.stringContaining("Import tools only through src/tools/index.ts")]);
  });
});
