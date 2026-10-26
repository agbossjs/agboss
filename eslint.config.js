import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { testRules } from "./eslint.tests.js";
import { componentStateRules, directTimeRules } from "./scripts/eslint-agboss-plugin.mjs";
import { flowStyleRules } from "./scripts/flow-style.mjs";
import { cliImportPatterns, packageImportPatterns } from "./scripts/public-entries.mjs";

/** What any framework module may not import (src/routers, tools and terns have their own rules). */
const frameworkImportPatterns = [
  {
    regex: "(^|/)examples/",
    message: "The framework never imports example code (#91).",
  },
  {
    regex: "/routers/(?!index\\.js$)",
    message: "Import routers only through src/routers/index.ts.",
  },
  {
    regex: "/tools/(?!index\\.js$)",
    message: "Import tools only through src/tools/index.ts.",
  },
  {
    regex: "/terns/(?!index\\.js$)",
    message: "Import terns only through src/terns/index.ts.",
  },
];

/** Every model call goes through ModelGateway (#135): only src/llm and src/routers touch clients. */
const modelClientImportPatterns = [
  {
    regex: "^@langchain/openai",
    message: "Model clients are created only behind ModelGateway (src/llm/gateway.ts).",
  },
  {
    regex: "/llm/(model|jev-client)\\.js$",
    message: "Model clients are created only behind ModelGateway (src/llm/gateway.ts).",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "**/coverage",
      "**/node_modules",
      ".artifacts",
      "packages/*/bin",
      "**/.scaffold-tmp",
      // copies of an example the generator tests write into (#197)
      "examples/.scaffold-tmp-*",
      "scratch/**",
      // the types `agboss check` / `check:types` generate (#272)
      "**/.agboss",
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
    },
  },
  {
    files: ["packages/agboss/src/routers/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)examples/",
              message: "The framework never imports example code (#91).",
            },
            {
              regex: "/(graph|agents|prompts|tools)/",
              message: "Routers are isolated: depend only on config, finops and llm.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/agboss/src/tools/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)examples/",
              message: "The framework never imports example code (#91).",
            },
            {
              regex: "/(graph|agents|prompts|routers)/",
              message: "Tools are isolated: depend only on config, finops and llm.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/agboss/src/terns/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)examples/",
              message: "The framework never imports example code (#91).",
            },
            {
              regex: "^\\.\\./",
              message: "Terns are isolated: they depend on nothing else in src.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/agboss/src/**/*.ts"],
    ignores: [
      "packages/agboss/src/llm/**",
      "packages/agboss/src/models/**",
      "packages/agboss/src/routers/**",
      "packages/agboss/src/tools/**",
      "packages/agboss/src/terns/**",
      "packages/agboss/src/bundles/**",
      "packages/agboss/src/demos/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [...frameworkImportPatterns, ...modelClientImportPatterns] },
      ],
    },
  },
  {
    // the model-call seam itself (#135): src/llm and the model providers (#151) create the clients
    files: ["packages/agboss/src/llm/**/*.ts", "packages/agboss/src/models/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: frameworkImportPatterns }],
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
  testRules,
  componentStateRules,
  directTimeRules,
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
