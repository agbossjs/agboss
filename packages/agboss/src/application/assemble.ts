import { workflowOf } from "../components/assemble.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class, Provider } from "../components/injection.js";
import { moduleOf } from "../components/module.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { GraphRuleError, type RuleViolation } from "../graph/rule-error.js";
import { containerProvidersOf } from "../models/resolution.js";
import { withProfile } from "../profile-workflow.js";
import { hours, seconds, type Milliseconds } from "../units/index.js";
import { COMPENSATION_TIMEOUT } from "../flow/compensation.js";
import type { AssembledWorkflow } from "../workflow.js";
import { requireApplication, type ApplicationOptions } from "./application.js";
import { applicationRuleViolations } from "./application-rules.js";
import { crossWorkflowViolations } from "./workflow-rules.js";
import type { ExecutionContextClass, TenantContextClass } from "../flow/context/context-values.js";
import { ExecutionContext } from "../flow/context/execution-context.js";
import { TenantContext } from "../flow/context/tenant-context.js";
import { contextTokensOf } from "../components/context-tokens.js";
import { checkContextFields } from "../flow/context/context-rules.js";
import { checkObservers } from "../components/observer-checks.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { decoratedHealthChecksOf } from "../health/health-check.js";
import { DEFAULT_MAX_MESH_HOPS } from "../mesh/mesh-defaults.js";
import type { MeshOptions } from "../mesh/mesh-options.js";

/** `@Application({ maxMeshHops, mesh })` (#398), as assembled. */
const meshOptionsOf = (
  options: ApplicationOptions,
): Pick<AssembledApplication, "maxMeshHops" | "mesh"> => ({
  maxMeshHops: options.maxMeshHops ?? DEFAULT_MAX_MESH_HOPS,
  ...(options.mesh === undefined ? {} : { mesh: options.mesh }),
});

/**
 * The assembly of an `@Application` (#261): its own rules (names, its workflows, budgets, where the
 * infrastructure is listed), every workflow assembled with the application's providers (each model
 * resolved to one of its model providers, #266), then the
 * rules across workflows (a start is the door of one workflow, names unique in the application).
 * Every violation at once, before any model call.
 */

/** An assembled application: what `createApp` and `testWith` build an app instance from. */
export interface AssembledApplication {
  readonly application: Class;
  readonly name: string;
  readonly version: string;
  /** The file `@Application` is declared in: its `environments/` folder is next to it. */
  readonly source?: string;
  /** `@Application({ environment })`: the contract its environments are typed by. */
  readonly environment?: Class;
  /** The application's own providers and budgets, then every workflow's providers. */
  readonly modules: readonly ProviderModule[];
  /** `@Application({ providers })` as listed (its infrastructure, its model providers). */
  readonly providers: readonly Provider[];
  readonly budgets: readonly Class[];
  /** `@Application({ observers })`: every execution's observers, in the order listed. */
  readonly observers: readonly Class[];
  /** `@Application({ healthChecks })` (#300): the project's readiness checks, in the order listed. */
  readonly healthChecks: readonly Class[];
  /** The workflows in the order listed, then the child workflows they launch that are not listed. */
  readonly workflows: readonly AssembledWorkflow[];
  /** How long a stop waits for the running executions (`@Application({ shutdownTimeout })`). */
  readonly shutdownTimeout: Milliseconds;
  /** How long a resolved pause record is kept (`@Application({ pauseRecordRetention })`, #267 S107). */
  readonly pauseRecordRetention: Milliseconds;
  /** Each automatic undo action's bound (`@Application({ compensationTimeout })`, #340). */
  readonly compensationTimeout: Milliseconds;
  /** `@Application({ maxConcurrentSteps })` (#332): the instance's cap on steps; absent = none. */
  readonly maxConcurrentSteps?: number;
  /** `@Application({ maxMeshHops })` (#398): the longest call chain it accepts. */
  readonly maxMeshHops: number;
  /** `@Application({ mesh })` (#398 PR 2): its keys' fields and the answers' retention. */
  readonly mesh?: MeshOptions;
  /** The context classes it declares (#261), else the built-in ones. */
  readonly tenantContext: TenantContextClass;
  readonly executionContext: ExecutionContextClass;
  /** `@Application({ piiPolicies })` (#120): every workflow's, and what its own log is masked by. */
  readonly piiPolicies: readonly Class[];
  /** `@Application({ pseudonymKey })` (#120): the environment field of its PII key. */
  readonly pseudonymKey?: string;
}

/** How long a resolved pause record is kept by default (#267 S107): a late answer is told apart a day. */
const PAUSE_RECORD_RETENTION: Milliseconds = hours(24);

/** The default shutdown timeout (#265 S51): under the usual 30 s grace period and the 30 s lease. */
const SHUTDOWN_TIMEOUT: Milliseconds = seconds(25);

/** How the workflows are assembled: a profile on top of each (`profiles/<workflow>/<profile>.yaml`). */
export interface ApplicationAssembly {
  readonly profile?: string | undefined;
  readonly profileRoot?: string | undefined;
}

/**
 * The application's own module: its providers, budgets, observers and health checks (the container
 * creates them)
 * — not its `@ModelProvider` classes, which its workflows resolve their models to (#266).
 */
export const applicationModule = (options: ApplicationOptions): ProviderModule => ({
  owner: options.name,
  declaredIn: "@Application",
  providers: [
    ...containerProvidersOf(options.providers),
    ...(options.budgets ?? []),
    ...(options.observers ?? []),
    ...decoratedHealthChecksOf(options.healthChecks),
  ],
});

/** The modules of every workflow listed (each `@Workflow` class's own providers). */
export const workflowModules = (workflows: readonly Class[]): ProviderModule[] =>
  workflows.flatMap((workflow) => {
    if (declarationOf(workflow)?.kind !== NodeKind.Workflow) return [];
    const module = moduleOf(workflow);
    return [{ owner: module.name, providers: module.providers ?? [] }];
  });

/** Each workflow assembled; the rule violations of all of them collected, other errors rethrown. */
async function assembleWorkflows(
  workflows: readonly Class[],
  modules: readonly ProviderModule[],
  assembly: ApplicationAssembly,
  owner: ApplicationOptions,
): Promise<{ readonly assembled: AssembledWorkflow[]; readonly errors: GraphRuleError[] }> {
  const assembled: AssembledWorkflow[] = [];
  const errors: GraphRuleError[] = [];
  const contexts = contextTokensOf(declaredContextsOf(owner));
  for (const workflow of workflows) {
    try {
      const bundle = await workflowOf(workflow, modules, owner, contexts);
      assembled.push(await withProfile(bundle, assembly.profile, assembly.profileRoot));
    } catch (error) {
      if (!(error instanceof GraphRuleError)) throw error;
      errors.push(error);
    }
  }
  return { assembled, errors };
}

/** The rules an application breaks, its workflows' included: a `GraphRuleError` naming the application. */
class ApplicationRuleError extends GraphRuleError {
  constructor(violations: readonly RuleViolation[]) {
    super(violations);
    const lines = violations.map((item) => `  - [${item.code}] ${item.message}`);
    this.message = `The application breaks ${String(violations.length)} rule(s):\n${lines.join("\n")}`;
  }
}

/** One error for everything found: a single workflow's own error as it is, else all violations. */
function throwIfAny(own: readonly RuleViolation[], errors: readonly GraphRuleError[]): void {
  const [only] = errors;
  if (own.length === 0 && errors.length === 1 && only !== undefined) throw only;
  const all = [...own, ...errors.flatMap((error) => error.violations)];
  if (all.length > 0) throw new ApplicationRuleError(all);
}

/** Its PII settings (#120): the policies of every workflow and the field of its key. */
const piiOptionsOf = (
  options: ApplicationOptions,
): Pick<AssembledApplication, "piiPolicies" | "pseudonymKey"> => ({
  piiPolicies: options.piiPolicies ?? [],
  ...(options.pseudonymKey === undefined ? {} : { pseudonymKey: options.pseudonymKey }),
});

/** What the application lists besides its workflows, each list empty when it lists none. */
const listedOf = (
  options: ApplicationOptions,
): Pick<AssembledApplication, "providers" | "budgets" | "observers" | "healthChecks"> => ({
  providers: options.providers ?? [],
  budgets: options.budgets ?? [],
  observers: options.observers ?? [],
  healthChecks: options.healthChecks ?? [],
});

/** The context classes an application declares, else the built-in ones (#261). */
export const declaredContextsOf = (
  options: Pick<ApplicationOptions, "tenantContext" | "executionContext">,
): Pick<AssembledApplication, "tenantContext" | "executionContext"> => ({
  tenantContext: options.tenantContext ?? TenantContext,
  executionContext: options.executionContext ?? ExecutionContext,
});

const withEnvironment = (contract: Class | undefined): { readonly environment?: Class } =>
  contract === undefined ? {} : { environment: contract };

export async function applicationOf(
  application: Class,
  assembly: ApplicationAssembly = {},
  where = "createApp",
): Promise<AssembledApplication> {
  const { options, source } = requireApplication(application, where);
  checkContextFields(options);
  checkObservers(options.observers ?? []);
  const own = applicationRuleViolations(application, options);
  // a child workflow is a workflow of the application, listed or not (#263 S74 c)
  const all = withChildWorkflows(options.workflows);
  const modules = [applicationModule(options), ...workflowModules(all)];
  const workflows = all.filter((workflow) => declarationOf(workflow)?.kind === NodeKind.Workflow);
  const { assembled, errors } = await assembleWorkflows(workflows, modules, assembly, options);
  throwIfAny([...own, ...crossWorkflowViolations(assembled)], errors);
  return {
    application,
    name: options.name,
    version: options.version,
    ...(source === undefined ? {} : { source }),
    // required by the type; an untyped (JS) caller may leave it out — then the environment is empty
    ...withEnvironment((options as Partial<ApplicationOptions>).environment),
    modules,
    ...listedOf(options),
    workflows: assembled,
    shutdownTimeout: options.shutdownTimeout ?? SHUTDOWN_TIMEOUT,
    pauseRecordRetention: options.pauseRecordRetention ?? PAUSE_RECORD_RETENTION,
    compensationTimeout: options.compensationTimeout ?? COMPENSATION_TIMEOUT,
    ...(options.maxConcurrentSteps === undefined
      ? {}
      : { maxConcurrentSteps: options.maxConcurrentSteps }),
    ...meshOptionsOf(options),
    ...declaredContextsOf(options),
    ...piiOptionsOf(options),
  };
}
