// One call per line in flow chains (#289). Prettier joins a short chain such as
// `start(A).returns(B).toFinish(C)` onto one line, so the files that hold flows — workflow modules
// and the framework's flow fixtures — are left out of Prettier (`.prettierignore` lists the same
// globs, `tests/docs/flow-style.test.ts` keeps the two lists equal) and formatted by ESLint instead:
// `@stylistic/newline-per-chained-call` puts every call of a chain on its own line, and the
// `@stylistic` rules below keep the rest of those files as Prettier would (`.prettierrc`: width
// 100, double quotes, trailing commas). `make fmt` runs `eslint --fix` on them after Prettier.
import stylistic from "@stylistic/eslint-plugin";
import { FLOW_CHAIN_RULE } from "agboss/eslint";

// the rule itself — a chain of two calls or more has one call per line — is the one a project made
// by `agboss create` lints its workflow modules with (#388)
export { FLOW_CHAIN_RULE };

/** The files formatted by ESLint instead of Prettier. Keep in step with `.prettierignore`. */
export const FLOW_FILES = [
  "**/*.workflow.ts",
  "packages/agboss/tests/flow/fixtures/*.ts",
  "packages/agboss/tests/helpers/flow.ts",
  "packages/agboss/tests/fixtures/test-flow/*.ts",
  "packages/agboss/tests/components/prompts/flows.ts",
  "packages/agboss/tests/core/observers/fixture.ts",
  "packages/agboss/tests/errors/fixtures.ts",
  "packages/agboss/tests/flow/types/fixture-workflows.ts",
];

/** What Prettier would otherwise have kept in those files (`.prettierrc`). */
const FORMAT_RULES = {
  "@stylistic/indent": [
    "error",
    2,
    {
      SwitchCase: 1,
      MemberExpression: 1,
      flatTernaryExpressions: false,
      offsetTernaryExpressions: true,
      // Prettier's long `class X\n  implements A, B\n{` and its unions keep their own layout
      ignoredNodes: ["TSUnionType", "TSIntersectionType", "ClassDeclaration[implements.length>0]"],
    },
  ],
  "@stylistic/max-len": [
    "error",
    {
      code: 100,
      ignoreComments: true,
      ignoreUrls: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true,
      ignoreRegExpLiterals: true,
    },
  ],
  "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
  "@stylistic/semi": ["error", "always"],
  "@stylistic/comma-dangle": ["error", "always-multiline"],
  "@stylistic/comma-spacing": "error",
  "@stylistic/comma-style": "error",
  "@stylistic/dot-location": ["error", "property"],
  "@stylistic/eol-last": "error",
  "@stylistic/no-trailing-spaces": "error",
  "@stylistic/no-multiple-empty-lines": ["error", { max: 1, maxBOF: 0, maxEOF: 0 }],
  "@stylistic/no-multi-spaces": "error",
  "@stylistic/no-tabs": "error",
  "@stylistic/object-curly-spacing": ["error", "always"],
  "@stylistic/array-bracket-spacing": ["error", "never"],
  "@stylistic/array-bracket-newline": ["error", "consistent"],
  "@stylistic/space-in-parens": "error",
  "@stylistic/key-spacing": "error",
  "@stylistic/keyword-spacing": "error",
  "@stylistic/space-before-blocks": "error",
  "@stylistic/space-infix-ops": "error",
  "@stylistic/arrow-spacing": "error",
  "@stylistic/arrow-parens": ["error", "always"],
  "@stylistic/block-spacing": "error",
  "@stylistic/semi-spacing": "error",
  "@stylistic/type-annotation-spacing": "error",
  "@stylistic/member-delimiter-style": "error",
  "@stylistic/quote-props": ["error", "as-needed"],
};

/** The ESLint config block for the flow files. */
export const flowStyleRules = {
  files: FLOW_FILES,
  plugins: { "@stylistic": stylistic },
  rules: { ...FLOW_CHAIN_RULE, ...FORMAT_RULES },
};
