/**
 * #818 AC6: `agboss/no-internal-import` — `@agboss/core/internal` is the CLI's, with no semver
 * promise; a project (the config `agboss create` writes) and the examples import the public entries
 * only. The rule is linted here from the plugin's source, outside any config of the repository, and
 * through this repository's config on an in-repo example's file.
 */
import { TSESLint } from "@typescript-eslint/utils";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { agbossPlugin } from "../../src/eslint/index.js";

const RULE = "agboss/no-internal-import";
const linter = new TSESLint.Linter({ configType: "flat" });

/** The rule's findings for `code`, as a project's test file. */
const findings = (code: string): readonly string[] =>
  linter
    .verify(
      code,
      [
        {
          files: ["**/*.ts"],
          languageOptions: { parser: tseslint.parser },
          plugins: { agboss: agbossPlugin },
          rules: { [RULE]: "error" },
        },
      ],
      "tests/graph.test.ts",
    )
    .filter((message) => message.ruleId === RULE)
    .map((message) => message.message);

describe("#818: agboss/no-internal-import", () => {
  it("flags an import of @agboss/core/internal, naming the public entry to use", () => {
    const found = findings('import { studioOf } from "@agboss/core/internal";');

    expect(found).toEqual([
      expect.stringMatching(
        /^`@agboss\/core\/internal` is not for projects: it is the agboss CLI's, with no semver promise — .*`studioOf` is in `@agboss\/core\/testing`/u,
      ) as unknown,
    ]);
  });

  it("flags every way a module names it, a path under it too", () => {
    const found = findings(
      [
        'import type { AssembledApplication } from "@agboss/core/internal";',
        'export { replay } from "@agboss/core/internal";',
        'export * from "@agboss/core/internal/x.js";',
        'const internals = await import("@agboss/core/internal");',
        'import cli = require("@agboss/core/internal");',
        'const required: unknown = require("@agboss/core/internal");',
        'type Graphs = import("@agboss/core/internal").StudioGraphs;',
        "export const all = [internals, cli, required] as const;",
        "export type { Graphs };",
      ].join("\n"),
    );

    expect(found).toHaveLength(7);
  });

  it("leaves the public entries and look-alike names alone", () => {
    const found = findings(
      [
        'import { studioOf } from "@agboss/core/testing";',
        'import { Agent } from "@agboss/core";',
        'import { Rag } from "@agboss/core/rag";',
        'import { internal } from "@agboss/core/internals";',
        'import { local } from "./@agboss/core/internal";',
        'const dynamic = await import(`@agboss/core/${"internal"}`);',
        "export const used = [studioOf, Agent, Rag, internal, local, dynamic] as const;",
      ].join("\n"),
    );

    expect(found).toEqual([]);
  });

  it("this repository's config refuses it in an example's test, as it did before by its allowlist", async () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const eslint = new ESLint({ cwd: root });
    const [result] = await eslint.lintText(
      'import { studioOf } from "@agboss/core/internal";\nexport const graphs = studioOf;\n',
      { filePath: `${root}examples/flow-patterns/tests/config/budget.config.test.ts` },
    );

    expect((result?.messages ?? []).map((message) => message.ruleId)).toContain(RULE);
  }, 60_000);
});
