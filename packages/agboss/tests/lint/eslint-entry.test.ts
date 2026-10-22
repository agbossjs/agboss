/**
 * #388 S2: `agboss/eslint` — the lint rules a project's ESLint config loads (the one `agboss create`
 * writes) — as a public entry: its plugin flags component state and direct time, naming the rule,
 * and `FLOW_CHAIN_RULE` is the framework's one-call-per-line options. Linted here from the source,
 * outside any config of the repository.
 */
import { TSESLint } from "@typescript-eslint/utils";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { FLOW_CHAIN_RULE, agbossPlugin } from "../../src/eslint/index.js";

// typescript-eslint's Linter: its config types are the ones a typed `eslint.config.ts` (with
// `tseslint.config`) gives the plugin
const linter = new TSESLint.Linter({ configType: "flat" });

/** The rule ids and messages the plugin's two rules report for `code`, as a project file. */
function findings(code: string): readonly string[] {
  return linter
    .verify(
      code,
      [
        {
          files: ["**/*.ts"],
          languageOptions: { parser: tseslint.parser },
          plugins: { agboss: agbossPlugin },
          rules: { "agboss/no-component-state": "error", "agboss/no-direct-time": "error" },
        },
      ],
      "src/services/clock-user.service.ts",
    )
    .map((message) => `${message.ruleId ?? ""}: ${message.message}`);
}

describe("#388 S2: the agboss/eslint entry", () => {
  it("flags state kept on a component and direct time, each with its rule", () => {
    const found = findings(
      [
        'import { Injectable } from "agboss";',
        "@Injectable()",
        "export class SeenService {",
        "  private last = 0;",
        "  touch(): number {",
        "    this.last = Date.now();",
        "    return this.last;",
        "  }",
        "}",
      ].join("\n"),
    );

    expect(found).toEqual([
      expect.stringMatching(
        /^agboss\/no-component-state: `this\.last = …` outside the constructor of a @Injectable/,
      ),
      expect.stringMatching(/^agboss\/no-direct-time: `Date\.now` reads the time directly: inject/),
    ]);
  });

  it("leaves the constructor, a class without a component decorator and a local Date alone", () => {
    const found = findings(
      [
        'import { Injectable } from "agboss";',
        "@Injectable()",
        "export class SeenService {",
        "  private readonly at: number;",
        "  constructor() {",
        "    this.at = 1;",
        "  }",
        "}",
        "export class PlainCounter {",
        "  count = 0;",
        "  add(): void {",
        "    this.count++;",
        "  }",
        "}",
        "export function stamp(Date: { now(): number }): number {",
        "  return Date.now();",
        "}",
      ].join("\n"),
    );

    expect(found).toEqual([]);
  });

  it("FLOW_CHAIN_RULE is newline-per-chained-call from the second call on", () => {
    expect(FLOW_CHAIN_RULE).toEqual({
      "@stylistic/newline-per-chained-call": ["error", { ignoreChainWithDepth: 1 }],
    });
    expect(Object.keys(agbossPlugin.rules)).toEqual(["no-component-state", "no-direct-time"]);
  });
});
