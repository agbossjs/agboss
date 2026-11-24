// One call per line in the docs' flow chains (#289): the ts snippets that hold a path (`onStart(…)`,
// `onAgent(…)`, `onRouter(…)`, `onAction(…)`, `route(…)`, `caseOf(…)`) are linted with the rule the
// workflow modules follow, `@stylistic/newline-per-chained-call` (scripts/flow-style.mjs). Prettier
// leaves the docs' code blocks alone (`embeddedLanguageFormatting: "off"` for `*.md`).
import stylistic from "@stylistic/eslint-plugin";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { FLOW_CHAIN_RULE } from "../flow-style.mjs";
import { sourceOf } from "./snippets.mjs";

const PATH_SOURCE =
  /(?<![\w.$])(?:onStart|onAgent|onRouter|onAction|onWorkflow|onExternalTask|route|caseOf)\(/;
const TYPESCRIPT = new Set(["ts", "typescript"]);
const linter = new Linter({ configType: "flat" });
const CONFIG = [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@stylistic": stylistic },
    rules: FLOW_CHAIN_RULE,
  },
];

/** Whether a snippet's own lines (not its hidden context) build a path. */
export const holdsFlow = (snippet) =>
  TYPESCRIPT.has(snippet.lang) && PATH_SOURCE.test(snippet.code.join("\n"));

/** Chains of the snippets' flows with two calls on one line, as `doc:line: message (rule)`. */
export function flowLintProblems(snippets) {
  const problems = [];
  for (const snippet of snippets.filter(holdsFlow)) {
    const { text, offset } = sourceOf(snippet);
    for (const message of linter.verify(text, CONFIG, "snippet.ts")) {
      // a snippet that does not parse is the typecheck's to report
      if (message.fatal) continue;
      const inCode = message.line - 1 - offset;
      if (inCode < 0 || inCode >= snippet.code.length) continue;
      const line = String(snippet.line + inCode);
      problems.push(`${snippet.doc}:${line}: ${message.message} (${message.ruleId})`);
    }
  }
  return problems;
}
