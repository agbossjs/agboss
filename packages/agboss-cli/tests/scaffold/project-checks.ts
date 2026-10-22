/**
 * What "a generated project is green" means (#197): tsc, the framework's ESLint rules, prettier with
 * the project's config, its own vitest suite and `agboss describe` on the workflow — each run as a user
 * would, in the project folder, with the monorepo's installed tools.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

export const repo = new URL("../../../..", import.meta.url).pathname;
const bin = (path: string): string => join(repo, "node_modules", path);
const agboss = join(repo, "packages/agboss-cli/bin/agboss.js");

export interface Ran {
  readonly ok: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly out: string;
}

export const run = (command: string, args: readonly string[], cwd: string): Ran => {
  const result = spawnSync(process.execPath, [command, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout,
    out: `${result.stdout}${result.stderr}`,
  };
};

export const agbossIn = (project: string, args: readonly string[]): Ran =>
  run(agboss, args, project);

/** Every source file of the project (not its dependencies). */
export function sourceFiles(project: string, folders: readonly string[]): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules") return [];
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return folders.flatMap((folder) => walk(join(project, folder)));
}

export const tscOf = (project: string): Ran =>
  run(bin("typescript/bin/tsc"), ["--noEmit", "-p", join(project, "tsconfig.json")], project);

/** The repo's ESLint config (examples get the examples' rules), even inside ignored temp folders. */
export const eslintOf = (project: string, folders: readonly string[]): Ran =>
  run(
    bin("eslint/bin/eslint.js"),
    ["--no-ignore", "--max-warnings", "0", ...folders.map((f) => join(project, f))],
    repo,
  );

/**
 * The project's own `npm run lint` (#388): `eslint .` in its folder, on the `eslint.config.js`
 * `agboss create` wrote — typescript-eslint and the AGBoss rules, from `agboss/eslint`.
 */
export const lintOf = (project: string): Ran =>
  run(bin("eslint/bin/eslint.js"), [".", "--max-warnings", "0"], project);

/**
 * `prettier --check` on the project's TypeScript, JSON and Markdown, ignoring no file but the
 * workflow modules: those keep one call per line in their chains, which Prettier would join (#289,
 * checked by `expectOneCallPerLine`).
 */
export function prettierOf(project: string, folders: readonly string[]): Ran {
  const files = sourceFiles(project, folders).filter(
    (f) => /\.(ts|json|md)$/.test(f) && !f.endsWith(".workflow.ts"),
  );
  expect(files.length).toBeGreaterThan(0);
  return run(
    bin("prettier/bin/prettier.cjs"),
    ["--check", "--ignore-path", join(project, ".no-ignore"), ...files],
    repo,
  );
}

export const vitestOf = (project: string, args: readonly string[] = []): Ran =>
  run(bin("vitest/vitest.mjs"), ["run", "--root", project, ...args], project);

/**
 * `.agboss/types.d.ts` as the project's `npm run types` writes it (#272): `agboss check` on an
 * application of `src/` types every workflow there. Its verdict is the tests' to check, not this helper's.
 */
export function writeTypes(project: string): void {
  const application = sourceFiles(project, ["src"]).find((file) =>
    file.endsWith(".application.ts"),
  );
  if (application !== undefined) agbossIn(project, ["check", "--application", application]);
}

/**
 * #289: the project's workflow modules pass `@stylistic/newline-per-chained-call` — the repo's rule
 * is on for each of them (`ignoreChainWithDepth: 1`) and ESLint finds nothing.
 */
export function expectOneCallPerLine(project: string, folders: readonly string[]): void {
  const workflows = sourceFiles(project, folders).filter((f) => f.endsWith(".workflow.ts"));
  for (const workflow of workflows) {
    const printed = run(
      bin("eslint/bin/eslint.js"),
      ["--no-ignore", "--print-config", workflow],
      repo,
    );
    const { rules } = JSON.parse(printed.stdout) as { rules: Record<string, unknown> };
    expect(rules["@stylistic/newline-per-chained-call"], workflow).toEqual([
      2,
      { ignoreChainWithDepth: 1 },
    ]);
  }
  const lint = eslintOf(project, folders);
  expect(lint.ok, lint.out).toBe(true);
}

/** tsc (on freshly written types), ESLint and prettier — all clean, with the output on failure. */
export function expectStaticChecks(project: string, folders: readonly string[]): void {
  writeTypes(project);
  const tsc = tscOf(project);
  expect(tsc.out, "tsc").toBe("");
  expectOneCallPerLine(project, folders);
  const prettier = prettierOf(project, folders);
  expect(prettier.ok, prettier.out).toBe(true);
}
