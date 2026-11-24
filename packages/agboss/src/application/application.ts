import type { Secret } from "../environments/secret.js";
import type { PromptVariables } from "../components/prompt-variables.js";
import { callerFile } from "../components/call-site.js";
import type { Class, Provider, ServiceEntry } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { NodeKind } from "../flow/ast.js";
import type { Milliseconds } from "../units/index.js";
import type { ApplicationDefaults } from "../flow/decorators/workflow.js";
import type { ExecutionContextClass, TenantContextClass } from "../flow/context/context-values.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import type { ExecutionObserver } from "../core/observer-hooks.js";
import type { WorkingCalendarSource } from "../calendar/working-calendar.js";
import type { RetentionOptions } from "./retention.js";
import { withStorageProviders, type ApplicationStorage } from "../storage/storage-assembly.js";

/**
 * `@Application({ isolatedWorker })` (#1286b, D9): the module a forked process loads to build the
 * application — its default export is the `@Application` class (usually the module that declares
 * it, `{ entry: import.meta.url }`). The fork builds it with the same settings and the same shared
 * stores as this instance (the child queue must be one the processes share: a SQLite file, PostgreSQL,
 * MongoDB, Redis — not the in-memory one), claims one child by its id, runs it and exits when it
 * ends or pauses. A fork that dies is a lost lease: another worker takes over and the child is
 * forked again.
 */
export interface IsolatedWorkerOptions {
  /** A file URL (`import.meta.url`) or an absolute path of the entry module. */
  readonly entry: string;
}

/** `@Application({ executionLimits })`: the limits of what the instance runs. */
export interface ApplicationExecutionLimits {
  /**
   * How long a child with `ChildPlacement.OtherWorker` waits for a worker other than the one that
   * launched it (#1286, D9): when none claims it in time its parent's step fails with
   * `StepError.ChildWorkerUnavailable` — it never runs on the launching instance. Default `minutes(1)`;
   * at most 24 hours (`[limits.timeout-invalid]`, #1141).
   */
  readonly childClaimTimeout?: Milliseconds;
  /**
   * How long `app.close()` (and SIGTERM / SIGINT) takes at most (#265 S51): the running executions,
   * interrupted `min(seconds(5), 20 %)` of it before its end (#367 S3: the grace for their step
   * bodies), stay `running` for another instance. Default `seconds(25)` — under the 30 s lease.
   * At most 24 hours (`[limits.timeout-invalid]`, #1141): a longer timer would fire at once.
   */
  readonly shutdownTimeout?: Milliseconds;
  /**
   * How many agent, router and action steps — a launch's branches too — this application instance
   * runs at once (#332), over every tree and every tenant: a whole number from 1
   * (`[limits.max-concurrent-steps-invalid]`). A step without a free slot waits in the instance's
   * queue (a step closing a branch first, then the deepest) — never an error; a full instance is
   * `Degraded` in `app.checkReadiness()` and its recovery sweep leaves orphaned executions to other
   * instances. Unset → no cap.
   */
  readonly maxConcurrentSteps?: number;
  /**
   * How long each automatic undo action may run (#340): an `@Action({ compensateWith })` undone
   * because no path could — its finished branches when a join fails — runs with a clean-up
   * `executionContext.signal` that aborts after this (and on a lost lease or the app's stop), not
   * the execution's; the wait for the launch's steps still running before the undo has the same
   * bound. Default `seconds(15)`; at most 24 hours (`[limits.timeout-invalid]`, #1141).
   */
  readonly compensationTimeout?: Milliseconds;
}

/**
 * `@Application` (#261) — the one point of the whole app: what `createApp(App, { env })` and
 * `testWith(App)` take. It lists the top-level workflows, the infrastructure (`providers`: a
 * framework contract's implementation, found by inheritance; none → the built-in in-memory default;
 * its model providers, #266)
 * and every budget of the application. Its `environments/` folder is next to its file.
 */
export interface ApplicationOptions<TEnvironment = unknown> {
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
   * Ordinary `@Injectable` services may be listed here too (#387: an A2A caller resolver): one
   * instance for every workflow, like a class a workflow lists.
   */
  readonly providers?: readonly Provider[];
  /**
   * Static `{{key}}` values of every prompt of the application (#1347c): texts or `defineEnv` references
   * (`appEnv.companyName`), read once at assembly. A workflow's own `promptVariables`, and a component's,
   * win over them. A secret reference is `[prompt.secret-in-instructions]`: a secret never reaches a model.
   */
  readonly promptVariables?: PromptVariables;
  /**
   * The `@Channel({ target })` classes of the application's pause targets (#1307): the transport of
   * each `@ToolApproval` and `@ExternalTask`, created by the container like a provider. Several
   * channels for one target need a `@ChannelSelector`.
   */
  readonly channels?: readonly Class[];
  /** The `@ChannelSelector` classes: each picks the channel of one target (#1307). */
  readonly channelSelectors?: readonly Class[];
  /** The `@ChannelListener` classes: told of every pause of the application (#1307, #1310). */
  readonly channelListeners?: readonly Class[];
  /**
   * The application's services (#1324): `@Injectable`, `@McpServer` and `@A2AAgent` classes bound to
   * abstract ports with their `injectAs`, and values bound with `provide(TOKEN, value)`. One instance
   * for every workflow; a workflow's own `services` bind the same port over these, for that workflow
   * alone. A concrete class reached through `deps` needs no listing.
   */
  readonly services?: readonly ServiceEntry[];
  /**
   * Where the application's rows go (#1321): `storage: AppDatabaseStorage`, or `storage: { database,
   * cluster?, objects? }` — `@DatabaseStorage`, `@ClusterStorage` and `@ObjectStorage` classes, each
   * holding its driver (`SqliteDriver`, `PostgresDriver`, `RedisDriver`, `S3Driver`, …). The stores
   * come from the drivers: a store class listed in `providers` beside it is
   * `[storage.providers-conflict]`. `auditLogTtl` and `ledgerEntriesTtl` of the database are where
   * `retention.auditLog` and `retention.costLedgerEntries` were.
   */
  readonly storage?: ApplicationStorage;
  /** Every `@Budget` of the application (`config/budget.config.ts`). */
  readonly budgets?: readonly Class[];
  /**
   * The `@Observer` classes, the only place observers are registered: one instance each, called
   * for every execution of the application — child executions included — within the
   * `workflows` / `agents` its decorator names. None listed → no observer is called.
   */
  readonly observers?: readonly Class<ExecutionObserver>[];
  /**
   * The project's readiness checks (#300): `@HealthCheck` classes, the only place they are listed — created by the container, run by `app.checkReadiness()` each
   * under its own `timeout`, besides the framework's own (the stores, the model providers' circuit
   * breakers, the recovery loop).
   */
  readonly healthChecks?: readonly Class[];
  /**
   * The application's calendar for working time (#944): `WorkingWeek.of({ timeZone, days, hours,
   * breaks, holidays })` or a `@WorkingCalendar` class listed in `providers`. A `workingHours(n)` /
   * `workingMinutes(n)` `expiresIn` or `remindBefore` counts by it — a role's own `workingCalendar`
   * over it. The deadline is computed once, when the pause opens: a calendar changed later does not
   * move open pauses (extend them instead). A grid with no working time at all, or a class that is no
   * listed `@WorkingCalendar`, is `[working-calendar.invalid]`.
   */
  readonly workingCalendar?: WorkingCalendarSource;
  /**
   * The `@ModelProvider` class every model of the application is served from unless its workflow
   * or its component names another (#1313): `Component.modelProvider ?? Workflow.modelProvider ??
   * Application.modelProvider`. List it in `providers`.
   */
  readonly modelProvider?: Class;
  /**
   * The application's identity and rules in the mesh (#398, #1320): its `@Mesh` class — `signingKey`
   * (envelopes, run reports and HTTP requests signed, EdDSA), `peers` whose signatures it verifies (any
   * of their `verifyKeys`), `inboundMode`, `maxHops`, `deduplicationTtl`. A request's budget, deadline,
   * origin and idempotency key are honoured only for an authenticated peer with a valid signature.
   */
  readonly mesh?: Class;
  /**
   * What the application serves to other applications (#398 PR 3): its `@A2AEndpoint` and
   * `@McpEndpoint` classes — `a2aHttpListener` serves only a listed one
   * (`[application.endpoint-unlisted]`), and `agboss describe --json` lists them as exported contracts.
   */
  readonly endpoints?: readonly Class[];
  /** The application's runtime limits, grouped (#1318c, D9). See `ApplicationExecutionLimits`. */
  readonly executionLimits?: ApplicationExecutionLimits;
  /**
   * Where the processes of the children with `ChildPlacement.IsolatedWorker` start (#1286b, D9),
   * required when a workflow of the application runs with it (`[application.isolated-worker-invalid]`).
   * Each such child runs in a process of its own, forked by this instance, which is a worker with its
   * own `instanceId` that claims only that child. See `IsolatedWorkerOptions`.
   */
  readonly isolatedWorker?: IsolatedWorkerOptions;
  /**
   * How long each kind of row the application keeps stays (#834): pause records, execution
   * records, the audit log, cost ledger entries, idempotent effects, outbound calls, mesh answers and
   * A2A tasks — the one place a retention is set, `[application.retention-invalid]`. See
   * `RetentionOptions`.
   */
  readonly retention?: RetentionOptions;
  /**
   * The environment contract, required — a class with declared fields only
   * (`environments/app.environment.ts`); each `environments/<name>.environment.ts` next to the
   * application file exports `const environment: AppEnvironment = { … }`. An application with no
   * settings declares `EmptyEnvironment` (a contract without fields) and needs no environment file.
   */
  readonly environment: Class<TEnvironment>;
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
   * The tool interceptors of every agent's tool calls in every workflow (#384): `@ToolInterceptor`
   * classes, outer first. Lists add up — a workflow's, an agent's and a tool's own come after;
   * `excludeToolInterceptors` removes one for an agent or a tool.
   */
  readonly toolInterceptors?: readonly Class[];
  /**
   * The application's PII key (#120): names a `Secret` field of the environment
   * (`piiKeyField: "piiPseudonymKey"` with `piiPseudonymKey: secret("PII_PSEUDONYM_KEY")`). Tokens of
   * `sensitive` fields, of a project's own detectors and of any policy without its own
   * `pseudonymKey` are made with it, so one value is one token on every instance. A policy's own key
   * wins; a policy that needs this one when it is not set fails the start, naming the field. Not set
   * and not needed → a key made per root execution (kept in its checkpoint, #334) and the warning
   * `[application.pii-instance-key]`. Only a `Secret` field of the contract compiles (#825), and one
   * that is also another key — a model provider's `apiKey`, the mesh's `signingKey`, an idempotency
   * key, a `Secret` a listed class reads — is `[application.pii-key-shared]`: rotating that key
   * would change every token.
   */
  readonly piiKeyField?: SecretFieldOf<TEnvironment>;
  /**
   * Defaults of every workflow (#261): merged field by field under each workflow's own `defaults`
   * — the most specific level that sets a field wins (component over workflow over application).
   */
  readonly defaults?: ApplicationDefaults;
}

/**
 * The `Secret` fields of an environment contract (#825): what `piiKeyField`,
 * `idempotencyKeyField` and `previousIdempotencyKeyField` may name — a typo or a text field does not
 * compile. Any text where the contract is not known.
 */
export type SecretFieldOf<TEnvironment> = unknown extends TEnvironment
  ? string
  : {
      [TField in keyof TEnvironment & string]-?: NonNullable<TEnvironment[TField]> extends Secret
        ? TField
        : never;
    }[keyof TEnvironment & string];

/** What `@Application` recorded: its options and the file it is declared in. */
export interface ApplicationDeclaration {
  readonly options: ApplicationOptions;
  /** The options as written, before the shelves, storage and services became providers (#1318: profiles replace them). */
  readonly written: ApplicationOptions;
  readonly source?: string;
}

const applications = new WeakMap<Class, ApplicationDeclaration>();

/** The applications that list each workflow, as they are declared (loaded modules only). */
const listedIn = new WeakMap<Class, Class[]>();

/**
 * `options` with the flat shelves (`channels`, `channelSelectors`, `channelListeners`) listed in
 * `providers`, after the application's own: everything downstream reads one list (#1307).
 */
function withShelfProviders(options: ApplicationOptions): ApplicationOptions {
  const shelves = [
    ...(options.channels ?? []),
    ...(options.channelSelectors ?? []),
    ...(options.channelListeners ?? []),
  ];
  if (shelves.length === 0) return options;
  const listed = options.providers ?? [];
  return { ...options, providers: [...listed, ...shelves.filter((cls) => !listed.includes(cls))] };
}

/**
 * The options as everything downstream reads them: `storage` becomes the stores in `providers`, the
 * shelves and `services` join them — one list. The storage's step is the last: it remembers the
 * options it was given, so a step after it would hide them from the storage rules.
 */
export const declaredOptionsOf = (options: ApplicationOptions): ApplicationOptions =>
  withStorageProviders(withServices(withShelfProviders(options)));

export function Application<TEnvironment>(options: ApplicationOptions<TEnvironment>) {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    // kept as the application's options: the contract's field types are a compile-time check only
    const written = options as ApplicationOptions;
    const declared = declaredOptionsOf(written);
    applications.set(
      value,
      source === undefined
        ? { options: declared, written }
        : { options: declared, written, source },
    );
    // a child workflow belongs to its parents' application, listed or not (#263)
    for (const workflow of withChildWorkflows(options.workflows))
      listedIn.set(workflow, [...(listedIn.get(workflow) ?? []), value]);
    return value;
  };
}

/** The `services` listed with the providers: one list, the application's own instances. */
function withServices(options: ApplicationOptions): ApplicationOptions {
  const { services, ...rest } = options;
  if (services === undefined) return options;
  return { ...rest, providers: [...(options.providers ?? []), ...services] };
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
  throw new ComponentError({ message: `${where} takes an @Application class: ${fix}` });
}

/** The applications loaded so far that list `workflow` (the CLI's commands on one workflow, eval). */
export const applicationsListing = (workflow: Class): readonly Class[] =>
  listedIn.get(workflow) ?? [];
