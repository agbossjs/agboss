import { ComponentKind } from "../flow/runtime/records.js";
import { movedRetentionViolations, retentionViolations } from "./retention.js";
import { budgetOf } from "../budgets/budget.js";
import { budgetRuleViolations, budgetsOfApplication } from "../budgets/budget-rules.js";
import type { OverlaidBudgets } from "../budgets/budget-overlay.js";
import { createdClassesOf, type Class, type Provider } from "../components/injection.js";
import { moduleOf } from "../components/module.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { kebabNameProblem, kindSuffixProblem, type NameKind } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { infrastructureContractOf } from "../infrastructure/contracts.js";
import { isModelProviderClass, modelProviderOf } from "../models/model-provider.decorator.js";
import { listedModelProvidersOf } from "../models/resolution.js";
import { providerPriceViolations, providerModeViolations } from "../models/provider-mode-rules.js";
import type { ApplicationOptions } from "./application.js";
import { contextRuleViolations } from "../flow/context/context-rules.js";
import { componentOf } from "../components/metadata.js";
import { channelUsesOf } from "../channels/discovery.js";
import { sharedInterpreterViolations } from "../channels/channel-rules.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { healthCheckRuleViolations } from "../health/health-check.js";
import { channelListenerRuleViolations } from "../pause/channel-listener.js";
import { workingCalendarNameViolations } from "../calendar/calendar-source.js";
import { meshRuleViolations } from "../mesh/mesh-rules.js";
import { providersOf } from "./listed-providers.js";
import { storeBackendViolations } from "./implementations.js";
import { storeDescriptorViolations } from "./store-descriptor-rule.js";
import { a2aMessageStoreViolations, a2aTaskStoreViolations } from "../a2a/a2a-task-store-rule.js";
import { messageSkillViolations } from "../a2a/a2a-message-skill-rule.js";
import { nestedFileFieldViolations } from "../a2a/a2a-nested-file-rule.js";
import { limitViolations } from "./limit-rules.js";
import { storageOwnedClassesOf } from "../storage/storage-assembly.js";
import { storageViolations } from "../storage/storage-rules.js";

/**
 * The rules of an `@Application` itself (#261), read from its declaration: its `name` and class end
 * with their kind, it lists workflows, its budgets are `@Budget`s that cap every workflow, every
 * tenant and the whole application, infrastructure is listed only in its `providers`, its environment
 * contract declares fields only (every field a listed framework implementation reads among them).
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
    declarationOf(workflow)?.kind === ComponentKind.Workflow
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

/** Every budget of an application: the listed ones and the ones its workflows attach (#1318). */
export { budgetsOfApplication };

/** The part of the options the budget rules read, with the limits the profiles give the budgets. */
const budgetedOf = (
  options: ApplicationOptions,
  budgetOverlays: OverlaidBudgets["budgetOverlays"],
) => ({
  name: options.name,
  workflows: options.workflows,
  budgets: options.budgets,
  tenantContext: options.tenantContext,
  budgetOverlays,
});

function budgetViolations(budgeted: ReturnType<typeof budgetedOf>): RuleViolation[] {
  return budgetsOfApplication(budgeted).flatMap((cls) => {
    const budget = budgetOf(cls);
    if (budget === undefined) {
      return [
        violation(
          "budget.not-a-budget",
          `${nameOf(cls)} in ${budgeted.name}'s budgets has no @Budget({ name, scope, … }) decorator`,
          [budgeted.name],
        ),
      ];
    }
    return nameViolations(budget.name, cls, ComponentKind.Budget, "Budget");
  });
}

/**
 * The classes the application and its workflows list in `providers` (#511: what reads the
 * environment) — a class given for a token too (#891: `provide(EXECUTION_ID_STORE, Class)`).
 */
export const listedClassesOf = (options: ApplicationOptions): readonly Class[] => [
  // the storage components' stores read their driver's settings, not the environment (#1321)
  ...createdClassesOf(providersOf(options)).filter(
    (cls) => !storageOwnedClassesOf(options).has(cls),
  ),
  ...withChildWorkflows(options.workflows)
    .filter((workflow) => declarationOf(workflow)?.kind === ComponentKind.Workflow)
    .flatMap((workflow) => createdClassesOf(providersOf(moduleOf(workflow)))),
];

/** A listed `@ModelProvider`'s `name` is kebab-case (#266 S73 c). */
function modelProviderNameViolations(options: ApplicationOptions): RuleViolation[] {
  return listedModelProvidersOf(options.providers).flatMap((cls) => {
    const { name } = modelProviderOf(cls);
    const problem = kebabNameProblem(name, "@ModelProvider");
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
    if (declarationOf(workflow)?.kind !== ComponentKind.Workflow) return [];
    const module = moduleOf(workflow);
    return createdClassesOf(providersOf(module)).flatMap((cls) => {
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

/** The application's providers and, besides them, the model provider it names (#1313): checked like a listed one. */
const withNamedModelProvider = (options: ApplicationOptions): readonly Provider[] => [
  ...new Set([
    ...(options.providers ?? []),
    ...(options.modelProvider === undefined ? [] : [options.modelProvider]),
  ]),
];

export function applicationRuleViolations(
  application: Class,
  options: ApplicationOptions,
  budgetOverlays?: OverlaidBudgets["budgetOverlays"],
): RuleViolation[] {
  return [
    ...nameViolations(options.name, application, ComponentKind.Application, "Application"),
    ...workflowListViolations(options),
    ...budgetViolations(budgetedOf(options, budgetOverlays)),
    ...budgetRuleViolations(budgetedOf(options, budgetOverlays)),
    ...modelProviderNameViolations(options),
    ...providerModeViolations(options.name, withNamedModelProvider(options)),
    ...providerPriceViolations(options.name, withNamedModelProvider(options)),
    ...infrastructureViolations(options),
    ...healthCheckRuleViolations(options),
    ...channelListenerRuleViolations(options.name, options.providers),
    ...workingCalendarNameViolations(options.name, listedClassesOf(options)),
    ...storageViolations(options.name, options),
    ...limitViolations(options),
    ...retentionViolations(options.name, (options as Partial<ApplicationOptions>).retention),
    ...movedRetentionViolations(options.name, options),
    // one transactional backend (#526): each fencing store with its lease store, one of each (#539)
    ...storeDescriptorViolations(options.name, providersOf(options)),
    ...storeBackendViolations(options.name, providersOf(options)),
    // an application serving A2A on shared leases keeps its tasks shared too (#824)
    ...a2aTaskStoreViolations(options),
    // a direct-reply skill is stateless, its replies kept where its tasks' ids are (#860)
    ...messageSkillViolations(options),
    ...a2aMessageStoreViolations(options),
    ...nestedFileFieldViolations(options),
    ...meshRuleViolations(options.name, options.mesh, options.endpoints),
    ...contextRuleViolations(options.name, options),
    ...sharedInterpreterViolations(channelUsesOf(options.workflows)),
  ];
}
