import { workflowOf } from "../components/assemble.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class, Provider } from "../components/injection.js";
import { moduleOf } from "../components/module.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { GraphRuleError, type RuleViolation } from "../graph/rule-error.js";
import { containerProvidersOf } from "../models/resolution.js";
import * as P from "./effective-options.js";
import { seconds, type Milliseconds } from "../units/index.js";
import { childFieldsOf } from "./child-fields.js";
import type { ChildPlacement } from "../flow/child-placement.js";
import { COMPENSATION_TIMEOUT } from "../flow/compensation.js";
import type { AssembledWorkflow } from "../workflow.js";
import {
  requireApplication,
  type ApplicationOptions,
  type IsolatedWorkerOptions,
} from "./application.js";
import { applicationRuleViolations, budgetsOfApplication } from "./application-rules.js";
import { assembledRetentionsOf, retentionOf } from "./retention.js";
import {
  idempotencyKeyViolations,
  keyFieldsOf,
  type AssembledKeyFields,
} from "./assembled-keys.js";
import { storageFieldsOf, type StorageFields } from "../storage/storage-fields.js";
import { crossWorkflowViolations } from "./workflow-rules.js";
import type { ExecutionContextClass, TenantContextClass } from "../flow/context/context-values.js";
import { ExecutionContext } from "../flow/context/execution-context.js";
import { TenantContext } from "../flow/context/tenant-context.js";
import { contextTokensOf } from "../components/context-tokens.js";
import { checkContextFields } from "../flow/context/context-rules.js";
import { checkObservers } from "../components/observer-checks.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { decoratedHealthChecksOf } from "../health/health-check.js";
import type { ApplicationAssembly } from "./assembly-options.js";
import type { ProfileSelection } from "../config/profile-names.js";
import { meshOptionsOf } from "../mesh/mesh-assembly.js";
import type { MeshMeta } from "../mesh/mesh.decorator.js";
import { OutboundMasking } from "../app/outbound-masking.js";

/**
 * The assembly of an `@Application` (#261): its own rules (names, its workflows, budgets, where the
 * infrastructure is listed), every workflow assembled with the application's providers (each model
 * resolved to one of its model providers, #266), then the
 * rules across workflows (a start is the door of one workflow, names unique in the application).
 * Every violation at once, before any model call.
 */

/** An assembled application: what `createApp` and `testWith` build an app instance from. */
export interface AssembledApplication extends AssembledKeyFields, StorageFields, P.ProfileFields {
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
  /** How long a resolved pause record is kept (`retention.pauseRecords`, #267 S107). */
  readonly pauseRecordRetention: Milliseconds;
  /** How long a root execution's history is kept (`retention.executionRecords`, #401); unset = not kept. */
  readonly executionRecordRetention?: Milliseconds;
  /** How long a row of the audit log is kept (`retention.auditLog`, #501). */
  readonly auditLogRetention?: Milliseconds | undefined;
  /** How long an entry of the cost ledger is kept (`retention.costLedgerEntries`, #771). */
  readonly ledgerEntryRetention?: Milliseconds | undefined;
  /** How long a trusted mesh request's answer is kept (`@Mesh({ deduplicationTtl })`, #398). */
  readonly meshAnswerRetention: Milliseconds;
  /** Each automatic undo action's bound (`@Application({ compensationTimeout })`, #340). */
  readonly compensationTimeout: Milliseconds;
  /** Whether a call's request is stored only masked (#505): what `Idempotency.sendOnce` reads. */
  readonly outboundMasking: OutboundMasking;
  /** `@Application({ childClaimTimeout })` (#1286, D9): how long an `OtherWorker` child waits to be claimed. */
  readonly childClaimTimeout: Milliseconds;
  /** `@Application({ defaults: { workflows: { placement } } })` (#1286); absent = `CurrentProcess`. */
  readonly childPlacement?: ChildPlacement;
  /** `@Application({ isolatedWorker })` (#1286b): where a forked process of an `IsolatedWorker` child starts. */
  readonly isolatedWorker?: IsolatedWorkerOptions;
  /** The profiles `createApp({ profile })` named, as given: a fork is started with the same (#1286b). */
  readonly profileSelection?: ProfileSelection;
  /** `@Application({ maxConcurrentSteps })` (#332): the instance's cap on steps; absent = none. */
  readonly maxConcurrentSteps?: number;
  /** `@Mesh({ maxHops })` (#398): the longest call chain it accepts. */
  readonly maxMeshHops: number;
  /** `@Application({ mesh })` (#398 PR 2, #1320): its `@Mesh`, as recorded. */
  readonly mesh?: MeshMeta;
  /** `@Application({ endpoints })` (#398 PR 3): its `@A2AEndpoint` / `@McpEndpoint` contracts. */
  readonly endpoints: readonly Class[];
  /** The context classes it declares (#261), else the built-in ones. */
  readonly tenantContext: TenantContextClass;
  readonly executionContext: ExecutionContextClass;
  /**
   * Whether it declares a `tenantContext` at all (#1324e): then a call on its `App` that needs a
   * tenant and names none is refused (`ValidationError.TenantRequired`), never run as `"default"`.
   */
  readonly hasTenantContext: boolean;
  /** `@Application({ piiPolicies })` (#120): every workflow's, and what its own log is masked by. */
  readonly piiPolicies: readonly Class[];
}

/** The default shutdown timeout (#265 S51): under the usual 30 s grace period and the 30 s lease. */
const SHUTDOWN_TIMEOUT: Milliseconds = seconds(25);

export type { ApplicationAssembly } from "./assembly-options.js";

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
    ...budgetsOfApplication(options),
    ...(options.observers ?? []),
    ...decoratedHealthChecksOf(options.healthChecks ?? []),
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
  profiles: P.AppliedProfiles,
): Promise<{ readonly assembled: AssembledWorkflow[]; readonly errors: GraphRuleError[] }> {
  const assembled: AssembledWorkflow[] = [];
  const errors: GraphRuleError[] = [];
  const owner = profiles.options;
  const contexts = contextTokensOf(declaredContextsOf(owner));
  for (const workflow of workflows) {
    try {
      const own = { ...owner, patch: profiles.patchOf(workflow) };
      assembled.push(await workflowOf(workflow, modules, own, contexts, assembly.processEnv));
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
    super({ violations });
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

/** What the application lists besides its workflows, each list empty when it lists none. */
const listedOf = (
  options: ApplicationOptions,
): Pick<AssembledApplication, "providers" | "budgets" | "observers" | "healthChecks"> => ({
  providers: options.providers ?? [],
  budgets: budgetsOfApplication(options),
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

/** Whether anything stored must be masked: the application or a workflow lists PII policies. */
const hasPiiPolicies = (
  options: ApplicationOptions,
  workflows: readonly AssembledWorkflow[],
): boolean =>
  (options.piiPolicies ?? []).length > 0 ||
  workflows.some((workflow) => (workflow.pii?.observability ?? []).length > 0);

export async function applicationOf(
  application: Class,
  assembly: ApplicationAssembly = {},
  where = "createApp",
): Promise<AssembledApplication> {
  const applied = await P.appliedProfilesOf(requireApplication(application, where), assembly);
  const { options, source } = applied;
  checkContextFields(options);
  checkObservers(options.observers ?? []);
  const own = applicationRuleViolations(application, options);
  // a child workflow is a workflow of the application, listed or not (#263 S74 c)
  const all = withChildWorkflows(options.workflows);
  const modules = [applicationModule(options), ...workflowModules(all)];
  const workflows = all.filter((workflow) => declarationOf(workflow)?.kind === NodeKind.Workflow);
  const { assembled, errors } = await assembleWorkflows(workflows, modules, assembly, applied);
  if (errors.length === 0) P.checkAppliedProfiles(applied, assembled);
  const keys = idempotencyKeyViolations(
    options,
    assembled,
    assembly.withoutIdempotencyKeys === true,
  );
  throwIfAny([...own, ...crossWorkflowViolations(assembled), ...keys], errors);
  const retention = retentionOf(options.retention);
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
    ...P.profileFieldsOf(applied),
    shutdownTimeout: options.shutdownTimeout ?? SHUTDOWN_TIMEOUT,
    ...assembledRetentionsOf(retention),
    ...storageFieldsOf(options.storage),
    compensationTimeout: options.compensationTimeout ?? COMPENSATION_TIMEOUT,
    outboundMasking: new OutboundMasking({ requiresMask: hasPiiPolicies(options, assembled) }),
    ...childFieldsOf(options),
    ...(assembly.profile === undefined ? {} : { profileSelection: assembly.profile }),
    ...(options.maxConcurrentSteps === undefined
      ? {}
      : { maxConcurrentSteps: options.maxConcurrentSteps }),
    ...meshOptionsOf(options),
    ...declaredContextsOf(options),
    hasTenantContext: options.tenantContext !== undefined,
    ...keyFieldsOf(options),
  };
}
