import { requireApplication } from "../../application/application.js";
import type { Class } from "../../components/injection.js";
import { ComponentError } from "../../components/metadata.js";
import { ExecutionContext } from "../../flow/context/execution-context.js";
import { TenantContext } from "../../flow/context/tenant-context.js";
import { throwIfViolated } from "../../graph/rule-error.js";
import { caseValueIssues } from "./case-values.js";
import { evalSuiteOf, type EvalSuiteMeta } from "./eval-suite.decorator.js";
import { EvalCaseInvalidError } from "./errors.js";
import { evalSuiteViolations } from "./suite-rules.js";

/**
 * Assembles an `@EvalSuite` against the application it runs on (#396), before anything runs: its
 * rules first — every violation at once, one `GraphRuleError` (`[name.kind-suffix]`,
 * `[eval.unknown-start]`, `[eval.duplicate-case]`, `[eval.judge-wrong-reply]`; a judge's own
 * `[judge.*]` rules as a `ComponentError`) — then its cases' values (`EvalCaseInvalidError`,
 * `eval.case-invalid`). Gives the suite as recorded.
 */
export function checkEvalSuite(application: Class, suite: Class): EvalSuiteMeta {
  const meta = evalSuiteOf(suite);
  if (meta === undefined)
    throw new ComponentError(
      `checkEvalSuite: ${suite.name || "(anonymous class)"} is not an @EvalSuite — decorate it with @EvalSuite({ name, description, start, checks, cascade, cases })`,
    );
  throwIfViolated(evalSuiteViolations(application, suite, meta));
  const { options } = requireApplication(application, "checkEvalSuite");
  const contexts = {
    tenantContext: options.tenantContext ?? TenantContext,
    executionContext: options.executionContext ?? ExecutionContext,
  };
  const issues = caseValueIssues(meta.start, contexts, meta.cases);
  if (issues.length > 0) throw new EvalCaseInvalidError(meta.name, issues);
  return meta;
}
