import { callerFile } from "../components/call-site.js";
import type { Class, Provider } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { NodeKind } from "../flow/ast.js";
import type { Milliseconds } from "../units/index.js";
import type { WorkflowDefaults } from "../flow/decorators/workflow.js";
import type { ExecutionContextClass, TenantContextClass } from "../flow/context/context-values.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import type { ObserverClass } from "../core/observer-hooks.js";

/**
 * `@Application` (#261) — the one point of the whole app: what `createApp(App, { env })` and
 * `testWith(App)` take. It lists the top-level workflows, the infrastructure (`providers`: a
 * framework contract's implementation, found by inheritance; none → the built-in in-memory default;
 * its model providers, #266)
 * and every budget of the application. Its `environments/` folder is next to its file.
 */
export interface ApplicationOptions {
  /** Ends with `-application` (`job-scout-application`). */
  readonly name: string;
  /** The release version (each workflow's own `version` is its behaviour version). */
  readonly version: string;
  /** The top-level workflows; `app.execute(Start, …)` runs any of them by its start. */
  readonly workflows: readonly Class[];
  /**
   * Infrastructure, the only place it is registered: classes that `extends` a framework contract
   * (`CostLedgerRepository`, `ExecutionRecordRepository`, `PausedExecutionRepository`,
   * `BaseCheckpointSaver`), created by the container — never `new`; and the `@ModelProvider`
   * classes (#266) every model of the application resolves to by `serves` — none listed → the
   * built-in `OpenRouterModelProvider` + `DecisionsModelProvider`, one listed → the list is complete.
   */
  readonly providers?: readonly Provider[];
  /** Every `@Budget` of the application (`config/budget.config.ts`). */
  readonly budgets?: readonly Class[];
  /**
   * The observers (`implements OnExecutionEnd, OnToolEnd, …`, `@Injectable`), the only place they
   * are registered: one instance each, called for every execution of the application — child
   * executions included (filter by `event.workflow.name`). None listed → no observer is called.
   */
  readonly observers?: readonly ObserverClass[];
  /**
   * How long `app.close()` (and SIGTERM / SIGINT) waits for the running executions before it
   * interrupts them (#265 S51): each releases its lease at once and stays `running`, so another
   * instance continues it. Default `seconds(25)` — under the usual 30 s grace period and the lease.
   */
  readonly shutdownTimeout?: Milliseconds;
  /**
   * How long a resolved pause record (`Taken`, `Cancelled`) is kept after it was resolved (#267
   * S107): within it a late answer gets `NotPausedError`, after it `UnknownPauseError`; the
   * recovery sweep removes it on the `Clock`. A pending pause is never removed. Default `hours(24)`.
   */
  readonly pauseRecordRetention?: Milliseconds;
  /**
   * The environment contract, required — a class with declared fields only
   * (`environments/app.environment.ts`); each `environments/<name>.environment.ts` next to the
   * application file exports `const environment: AppEnvironment = { … }`. An application with no
   * settings declares `EmptyEnvironment` (a contract without fields) and needs no environment file.
   */
  readonly environment: Class;
  /**
   * The project's tenant level (#261): a subclass of `TenantContext` with DTO field decorators
   * (`config/context.config.ts`). Its fields are then required at every `app.execute(…, { tenant })`;
   * omitted → the built-in `TenantContext` (`tenant: { tenantId? }`, default `"default"`).
   */
  readonly tenantContext?: TenantContextClass;
  /**
   * The project's execution level (#261): a subclass of `ExecutionContext` — who the execution
   * talks to and what else it carries. Its fields come as `app.execute(…, { execution })`;
   * omitted → the built-in `ExecutionContext`, and `execution` does not compile. Identity only,
   * never secrets.
   */
  readonly executionContext?: ExecutionContextClass;
  /**
   * The PII policies of every agent and router of every workflow (#120): `@PiiPolicy` classes. Lists
   * add up — a workflow's and an element's own come on top, `excludePiiPolicies` removes one for an
   * agent's or a router's model and tools; logs and traces are always masked by them.
   */
  readonly piiPolicies?: readonly Class[];
  /**
   * The guardrails of every agent and model router of every workflow (#120): `@InputGuardrail` /
   * `@OutputGuardrail` classes. Lists add up — a workflow's and an element's own come on top,
   * `excludeGuardrails` removes one for an agent or a router.
   */
  readonly guardrails?: readonly Class[];
  /**
   * The application's PII key (#120): names a `Secret` field of the environment
   * (`pseudonymKey: "piiPseudonymKey"` with `piiPseudonymKey: secret("PII_PSEUDONYM_KEY")`). Tokens of
   * `sensitive` fields, of a project's own detectors and of any policy without its own
   * `pseudonymKey` are made with it, so one value is one token on every instance. A policy's own key
   * wins; a policy that needs this one when it is not set fails the start, naming the field. Not set
   * and not needed → a key made per instance and the warning `[application.pii-instance-key]`.
   */
  readonly pseudonymKey?: string;
  /**
   * Defaults of every workflow (#261): merged field by field under each workflow's own `defaults`
   * — the most specific level that sets a field wins (component over workflow over application).
   */
  readonly defaults?: WorkflowDefaults;
}

/** What `@Application` recorded: its options and the file it is declared in. */
export interface ApplicationDeclaration {
  readonly options: ApplicationOptions;
  readonly source?: string;
}

const applications = new WeakMap<Class, ApplicationDeclaration>();

/** The applications that list each workflow, as they are declared (loaded modules only). */
const listedIn = new WeakMap<Class, Class[]>();

export function Application(options: ApplicationOptions) {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    applications.set(value, source === undefined ? { options } : { options, source });
    // a child workflow belongs to its parents' application, listed or not (#263)
    for (const workflow of withChildWorkflows(options.workflows))
      listedIn.set(workflow, [...(listedIn.get(workflow) ?? []), value]);
    return value;
  };
}

/** What `@Application` recorded on a class; `undefined` for any other class. */
export const applicationDeclarationOf = (cls: Class): ApplicationDeclaration | undefined =>
  applications.get(cls);

/** The `@Application` declaration of a class; anything else fails, naming the fix. */
export function requireApplication(cls: Class, where: string): ApplicationDeclaration {
  const declaration = applications.get(cls);
  if (declaration !== undefined) return declaration;
  const name = cls.name || "(anonymous class)";
  const fix =
    declarationOf(cls)?.kind === NodeKind.Workflow
      ? `${name} is a @Workflow — list it in an @Application({ name, version, workflows: [${name}] }) and pass the application`
      : `decorate ${name} with @Application({ name, version, workflows })`;
  throw new ComponentError(`${where} takes an @Application class: ${fix}`);
}

/** The applications loaded so far that list `workflow` (the CLI's commands on one workflow, eval). */
export const applicationsListing = (workflow: Class): readonly Class[] =>
  listedIn.get(workflow) ?? [];
