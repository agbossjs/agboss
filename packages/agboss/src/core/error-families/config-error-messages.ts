import type { EvalCaseIssue } from "../../eval/suite/errors.js";
import type { RuleViolation } from "../../graph/rule-error.js";
import { ModelKind } from "../../models/model-kind.js";
import { problemLine, type ModelProblem } from "../../models/problems.js";

/** The sentences of the `ConfigError` variants made of their facts: every problem found, one line each. */

/** What `ConfigError.GraphRules` says: every rule broken, at once, before any model call. */
export const graphRulesMessageOf = (
  facts: Partial<{ readonly violations: readonly RuleViolation[] }>,
): string => {
  const violations = facts.violations ?? [];
  const lines = violations.map((item) => `  - [${item.code}] ${item.message}`);
  return `The workflow's flow breaks ${String(violations.length)} rule(s):\n${lines.join("\n")}`;
};

/** What `ConfigError.ModelSettings` says: every model setting that cannot work. */
export const modelSettingsMessageOf = (
  facts: Partial<{ readonly problems: readonly ModelProblem[] }>,
): string => {
  const problems = facts.problems ?? [];
  return problems.length === 0
    ? "a model's settings do not fit it"
    : `${String(problems.length)} model setting(s) do not fit their models:\n${problems
        .map((problem) => `  ${problemLine(problem)}`)
        .join("\n")}`;
};

/** What `ConfigError.ModelKind` says: the call, the model and what to call instead. */
export const modelKindMessageOf = (
  facts: Partial<{
    readonly model: string;
    readonly modelKind: ModelKind;
    readonly call: "invoke" | "decide";
  }>,
): string => {
  if (facts.model === undefined || facts.modelKind === undefined || facts.call === undefined)
    return "a model is used for what it cannot do";
  const instead = facts.modelKind === ModelKind.Chat ? "invoke(…)" : "decide(…)";
  return `${facts.call}(…) on ${facts.model}: it is a ${facts.modelKind} model — use ${instead}`;
};

/** What `ConfigError.EvalCase` says: the suite and every invalid value of its cases. */
export const evalCaseMessageOf = (
  facts: Partial<{ readonly suite: string; readonly issues: readonly EvalCaseIssue[] }>,
): string => {
  if (facts.suite === undefined || facts.issues === undefined) return "an eval case is not valid";
  const lines = facts.issues.map(
    (issue) => `  - case "${issue.case}": ${issue.path} — ${issue.reason}`,
  );
  return `${facts.suite}: ${String(facts.issues.length)} invalid value(s) in its cases:\n${lines.join("\n")}`;
};
