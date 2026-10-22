import { budgetOf } from "../budgets/budget.js";
import { budgetRuleViolations } from "../budgets/budget-rules.js";
import type { Class, Provider } from "../components/injection.js";
import { moduleOf } from "../components/module.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { kindSuffixProblem, NameKind } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { infrastructureContractOf } from "../infrastructure/contracts.js";
import { declaredFieldsOf, environmentRuleViolations } from "../environments/contract.js";
import { isModelProviderClass, modelProviderOf } from "../models/model-provider.decorator.js";
import type { ApplicationOptions } from "./application.js";
import { contextRuleViolations } from "../flow/context/context-rules.js";
import { componentOf } from "../components/metadata.js";
import { channelUsesOf } from "../channels/discovery.js";
import { sharedInterpreterViolations } from "../channels/channel-rules.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { healthCheckRuleViolations } from "../health/health-check.js";

/**
 * The rules of an `@Application` itself (#261), read from its declaration: its `name` and class end
 * with their kind, it lists workflows, its budgets are `@Budget`s that cap every workflow, every
 * tenant and the whole application, infrastructure is listed only
 * in its `providers`, its environment contract declares fields only — every field a listed
 * framework implementation reads among them — and its context subclasses' fields take no prompt.
 */

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** `name` ends with `-<kind>` and the class with `<Kind>` (`job-scout-application`, `…Application`). */
function nameViolations(
  name: string,
  cls: Class,
  kind: NameKind,
  classSuffix: string,
): RuleViolation[] {
  const found: RuleViolation[] = [];
  const problem = kindSuffixProblem(name, kind);
  if (problem !== undefined) found.push(violation(problem.code, problem.message, [name]));
  const className = nameOf(cls);
  if (className.length <= classSuffix.length || !className.endsWith(classSuffix)) {
    found.push(
      violation("name.kind-suffix", `class ${className} — name it ${className}${classSuffix}`, [
        name,
      ]),
    );
  }
  return found;
}

function workflowListViolations(options: ApplicationOptions): RuleViolation[] {
  if (options.workflows.length === 0) {
    return [
      violation(
        "application.no-workflows",
        `${options.name} lists no workflows — add them: @Application({ workflows: [...] })`,
        [options.name],
      ),
    ];
  }
  return options.workflows.flatMap((workflow) =>
    declarationOf(workflow)?.kind === NodeKind.Workflow
      ? []
      : [
          violation(
            "application.not-a-workflow",
            `${nameOf(workflow)} in ${options.name}'s workflows is not a @Workflow class`,
            [options.name],
          ),
        ],
  );
}

function budgetViolations(options: ApplicationOptions): RuleViolation[] {
  return (options.budgets ?? []).flatMap((cls) => {
    const budget = budgetOf(cls);
    if (budget === undefined) {
      return [
        violation(
          "budget.not-a-budget",
          `${nameOf(cls)} in ${options.name}'s budgets has no @Budget({ name, scope, … }) decorator`,
          [options.name],
        ),
      ];
    }
    return nameViolations(budget.name, cls, NameKind.Budget, "Budget");
  });
}

const isClass = (provider: Provider): provider is Class => !("provide" in provider);

/** A listed `@ModelProvider`'s `name` ends with `-model-provider` (#266 S73 c). */
function modelProviderNameViolations(options: ApplicationOptions): RuleViolation[] {
  return (options.providers ?? []).filter(isModelProviderClass).flatMap((cls) => {
    const { name } = modelProviderOf(cls);
    const problem = kindSuffixProblem(name, NameKind.ModelProvider);
    return problem === undefined ? [] : [violation(problem.code, problem.message, [options.name])];
  });
}

/** What makes a class infrastructure: the contract it `extends`, or `@ModelProvider` (#266). */
function infrastructureKindOf(cls: Class): string | undefined {
  if (isModelProviderClass(cls)) return "is a @ModelProvider";
  if (componentOf(cls)?.kind === "channel") return "is a @Channel (channel transport)";
  const contract = infrastructureContractOf(cls);
  return contract === undefined ? undefined : `extends ${nameOf(contract)}`;
}

/** Infrastructure in a workflow's `providers`: a contract's implementation or a model provider. */
function infrastructureViolations(options: ApplicationOptions): RuleViolation[] {
  // every workflow of the application: the listed ones and, transitively, their children (#263)
  return withChildWorkflows(options.workflows).flatMap((workflow) => {
    if (declarationOf(workflow)?.kind !== NodeKind.Workflow) return [];
    const module = moduleOf(workflow);
    return (module.providers ?? []).filter(isClass).flatMap((cls) => {
      const kind = infrastructureKindOf(cls);
      if (kind === undefined) return [];
      return [
        violation(
          "di.infrastructure-in-workflow",
          `${nameOf(cls)} ${kind} — infrastructure is listed only in @Application({ providers }), not in ${module.name}'s providers`,
          [module.name],
        ),
      ];
    });
  });
}

/** `pseudonymKey` names a field the environment contract declares (#120). */
function pseudonymKeyFieldViolations(options: ApplicationOptions): RuleViolation[] {
  const field = options.pseudonymKey;
  if (field === undefined) return [];
  const contract = (options as Partial<ApplicationOptions>).environment;
  if (contract !== undefined && declaredFieldsOf(contract).includes(field)) return [];
  const where = contract?.name ?? "the environment contract";
  return [
    violation(
      "environment.missing-field",
      `@Application pseudonymKey needs ${field}: Secret in ${where}`,
      [options.name],
    ),
  ];
}

/** `maxConcurrentSteps` is a whole number of steps from 1 (#332): 0 would stop the instance. */
function stepCapViolations(options: ApplicationOptions): RuleViolation[] {
  const value = options.maxConcurrentSteps;
  if (value === undefined || (Number.isInteger(value) && value >= 1)) return [];
  const message =
    `its maxConcurrentSteps is ${String(value)}, not a whole number of steps from 1 — ` +
    "@Application({ maxConcurrentSteps: 32 }) lets 32 steps of this instance work at once";
  return [violation("limits.max-concurrent-steps-invalid", message, [options.name])];
}

export function applicationRuleViolations(
  application: Class,
  options: ApplicationOptions,
): RuleViolation[] {
  return [
    ...nameViolations(options.name, application, NameKind.Application, "Application"),
    ...workflowListViolations(options),
    ...budgetViolations(options),
    ...budgetRuleViolations(options),
    ...modelProviderNameViolations(options),
    ...infrastructureViolations(options),
    ...environmentRuleViolations(
      options.name,
      options.environment,
      (options.providers ?? []).filter(isClass),
    ),
    ...pseudonymKeyFieldViolations(options),
    ...healthCheckRuleViolations(options),
    ...stepCapViolations(options),
    ...contextRuleViolations(options.name, options),
    ...sharedInterpreterViolations(channelUsesOf(options.workflows)),
  ];
}
