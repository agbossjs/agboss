import { ConfigError } from "../../core/error-families/config-errors.js";
import { requireApplication } from "../../application/application.js";
import type { Class } from "../../components/injection.js";
import { ExecutionContext } from "../../flow/context/execution-context.js";
import { TenantContext } from "../../flow/context/tenant-context.js";
import { throwIfViolated } from "../../graph/rule-error.js";
import { caseValueIssues } from "./case-values.js";
import { evalSuiteOf, type EvalSuiteMeta } from "./eval-suite.decorator.js";
import { evalSuiteViolations, evalSuiteWarnings } from "./suite-rules.js";
import type { RuleViolation } from "../../graph/rule-error.js";

/**
 * Assembles an `@EvalSuite` against the application it runs on (#396), before anything runs: its
 * rules first — every violation at once, one `ConfigError.GraphRules` (`[name.kind-suffix]`,
 * `[eval.unknown-start]`, `[eval.duplicate-case]`, `[eval.judge-wrong-output]`; a judge's own
 * `[judge.*]` rules as a `ConfigError.Component`) — then its cases' values (`ConfigError.EvalCase`,
 * `config.eval-case`). Gives the suite as recorded.
 */
export function checkEvalSuite(application: Class, suite: Class): EvalSuiteMeta {
  const meta = evalSuiteOf(suite);
  if (meta === undefined)
    throw new ConfigError.Component({
      message: `checkEvalSuite: ${suite.name || "(anonymous class)"} is not an @EvalSuite — decorate it with @EvalSuite({ name, start, judges, cases })`,
    });
  throwIfViolated(evalSuiteViolations(application, suite, meta));
  const { options } = requireApplication(application, "checkEvalSuite");
  const contexts = {
    tenantContext: options.tenantContext ?? TenantContext,
    executionContext: options.executionContext ?? ExecutionContext,
  };
  const issues = caseValueIssues(meta.start, contexts, meta.cases);
  if (issues.length > 0) throw new ConfigError.EvalCase({ suite: meta.name, issues });
  return meta;
}

/**
 * The warnings of a suite that assembles (#396 PR 5): its model judges of the same model family as
 * an agent of the workflow they judge (`[judge.same-model-family]`) — printed by `agboss check`,
 * errors under `--strict`.
 */
export function evalSuiteWarningsOf(application: Class, suite: Class): readonly RuleViolation[] {
  const meta = evalSuiteOf(suite);
  return meta === undefined ? [] : evalSuiteWarnings(application, meta);
}
