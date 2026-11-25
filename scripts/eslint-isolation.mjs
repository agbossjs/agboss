// The import-isolation rules of the framework's sources (routers, tools, turns, the model-call seam),
// split from eslint.config.js.

/** What any framework module may not import (src/routers, tools and turns have their own rules). */
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
    regex: "/turns/(?!index\\.js$)",
    message: "Import turns only through src/turns/index.ts.",
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

/** The flat-config blocks that keep the framework's layers apart. */
export const isolationRules = [
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
              regex: "/(graph|prompts|tools)/",
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
              regex: "/(graph|prompts|routers)/",
              message: "Tools are isolated: depend only on config, finops and llm.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/agboss/src/turns/**/*.ts"],
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
              // `../core/` and `../units/` only: core is the leaf layer of errors and has no dependencies
              // (#1194, so the turn store's stored texts are read with `parsedStoredJson`), units hold
              // `Usd` (#1318, a Turn's cost); turns stay isolated from infrastructure, stores and
              // everything else.
              regex: "^\\.\\./(?!(core|units)/)",
              message: "Turns are isolated: they depend on nothing else in src but core and units.",
            },
          ],
        },
      ],
    },
  },
  {
    // `Metadata` is a class of static methods by spec: one name that is both the call site and the type
    files: ["packages/agboss/src/flow/metadata.ts"],
    rules: { "@typescript-eslint/no-extraneous-class": ["error", { allowStaticOnly: true }] },
  },
  {
    files: ["packages/agboss/src/**/*.ts"],
    ignores: [
      "packages/agboss/src/llm/**",
      "packages/agboss/src/models/**",
      "packages/agboss/src/routers/**",
      "packages/agboss/src/tools/**",
      "packages/agboss/src/turns/**",
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
];
