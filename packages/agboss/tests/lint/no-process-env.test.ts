/**
 * #1324: `agboss/no-process-env` flags a raw `process.env` in a project's `src/` (read the variable with
 * `defineEnv`), lets `processEnv: process.env` through in an entry point and ignores test files; and
 * `agboss/no-component-state` knows the lifecycle hooks, destructuring, `delete` and `#private` fields.
 */
import { TSESLint } from "@typescript-eslint/utils";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { agbossPlugin } from "../../src/eslint/index.js";

const linter = new TSESLint.Linter({ configType: "flat" });

/** The messages of `rule` for `code` as the file `path`. */
function findings(rule: string, code: string, path = "src/desk/desk.service.ts"): string[] {
  return linter
    .verify(
      code,
      [
        {
          files: ["**/*.ts"],
          languageOptions: { parser: tseslint.parser },
          plugins: { agboss: agbossPlugin },
          rules: { [`agboss/${rule}`]: "error" },
        },
      ],
      path,
    )
    .map((message) => message.message);
}

describe("#1324: agboss/no-process-env", () => {
  it("flags every raw read of process.env", () => {
    const found = findings(
      "no-process-env",
      [
        'import { env as imported } from "node:process";',
        "export const a = process.env.KEY;",
        'export const b = process["env"].KEY;',
        "export const { env } = process;",
        "export const c = imported;",
      ].join("\n"),
    );

    expect(found).toHaveLength(4);
    expect(found[0]).toContain("defineEnv");
  });

  it("allows forwarding the object as processEnv, and a local named process", () => {
    expect(findings("no-process-env", "createApp(App, { processEnv: process.env });")).toEqual([]);
    expect(
      findings("no-process-env", "export const f = (process: { env: string }) => process.env;"),
    ).toEqual([]);
  });

  it("ignores test files", () => {
    for (const path of ["src/desk/desk.test.ts", "tests/desk.test.ts", "src/x.spec.ts"])
      expect(findings("no-process-env", "export const a = process.env.KEY;", path), path).toEqual(
        [],
      );
  });

  it("the plugin's recommended config registers the four rules", () => {
    const rules = agbossPlugin.configs.recommended.flatMap((block) =>
      Object.keys(block.rules ?? {}),
    );

    expect(rules.sort()).toEqual([
      "agboss/no-component-state",
      "agboss/no-direct-time",
      "agboss/no-internal-import",
      "agboss/no-process-env",
    ]);
  });
});

describe("#1324: agboss/no-component-state", () => {
  const component = (body: string): string =>
    `@Injectable({ deps: [] })\nexport class Cache {\n  #hits = 0;\n  private store = new Map<string, string>();\n${body}\n}\n`;

  it("lets a lifecycle hook wire a field, and flags the same write in any other method", () => {
    expect(
      findings("no-component-state", component("  onInit(): void { this.store = new Map(); }")),
    ).toEqual([]);
    expect(
      findings("no-component-state", component("  onReady(): void { this.#hits = 1; }")),
    ).toEqual([]);
    expect(
      findings("no-component-state", component("  onDestroy(): void { delete this.store; }")),
    ).toEqual([]);
    expect(
      findings("no-component-state", component("  get(): void { this.store = new Map(); }")),
    ).toHaveLength(1);
  });

  it("flags destructuring targets, delete and a #private field by its name", () => {
    const found = findings(
      "no-component-state",
      component(
        [
          "  a(src: { x: number }): void { ({ x: this.#hits } = src); }",
          "  b(src: string[]): void { [this.store] = [src[0]] as never; }",
          "  c(): void { delete this.store; }",
          "  d(): void { this.#hits++; }",
        ].join("\n"),
      ),
    );

    expect(found).toHaveLength(4);
    expect(found[0]).toContain("this.#hits");
  });
});
