import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { testRules } from "./eslint.tests.js";
import { agbossRules } from "./scripts/eslint-agboss-plugin.mjs";
import { isolationRules } from "./scripts/eslint-isolation.mjs";
import { flowStyleRules } from "./scripts/flow-style.mjs";
import { cliImportPatterns, packageImportPatterns } from "./scripts/public-entries.mjs";

export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "**/coverage",
      "**/.vitest-reports",
      "**/node_modules",
      ".artifacts",
      "packages/*/bin",
      "**/.scaffold-tmp",
      // a Stryker sandbox (a copy of the package) left behind by an interrupted mutation run
      "**/.stryker-tmp*",
      // copies of an example the generator tests write into (#197)
      "examples/.scaffold-tmp-*",
      "scratch/**",
      // the types `agboss check` / `check:types` generate (#272)
      "**/.agboss",
      // the official A2A TCK's clone and venv (scripts/a2a-tck.mjs, #811)
      ".a2a-tck",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/require-await": "off",
      "max-lines": ["error", { max: 200, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      complexity: ["error", 10],
      "no-console": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      // Angular-style components: @Agent / @Bundle / @McpServer / @McpTool classes are empty on purpose
      "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }],
      // typescript-eslint 8.73 added it to strictTypeChecked (agbossjs/agboss#1330, #1340): an object
      // literal where a DTO class (or a class the framework or a driver types) is the parameter type
      // is the documented call shape, as the project template has it off
      "@typescript-eslint/no-unsafe-class-instance-assignment": "off",
    },
  },
  {
    // #646: every dynamic import of the core is a lazy load the test's clock waits for
    files: ["packages/agboss/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportExpression:not(CallExpression[callee.name='lazyLoad'] > ImportExpression)",
          message:
            "load lazily through lazyLoad(import(…)) (infrastructure/clock.ts): a test's clock.advance waits for it (#646)",
        },
      ],
    },
  },
  {
    // An example uses AGBoss like any outside project: only its public entries, the allowlist
    // generated from packages/agboss/package.json#exports (#195), so they cannot drift.
    files: ["examples/*/src/**/*.ts", "examples/*/tests/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: packageImportPatterns() }],
    },
  },
  {
    // the `agboss` CLI (#205) is built on the framework's entries, `@agboss/core/internal` included
    files: ["packages/agboss-cli/src/**/*.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: cliImportPatterns() }] },
  },
  ...isolationRules,
  ...testRules,
  ...agbossRules,
  // one call per line in flow chains (#289): these files are formatted by ESLint, not Prettier
  flowStyleRules,
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
    // plain JS (lint rules, checks): no type annotations to give
    rules: { "no-console": "off", "@typescript-eslint/explicit-module-boundary-types": "off" },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", process: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
