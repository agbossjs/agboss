import type { Secret } from "../environments/secret.js";
import type { A2AFileOptions } from "../a2a/files/a2a-file-options.js";
import type {
  FencedEffectOptions,
  OutboundCallOptions,
} from "../infrastructure/fenced-effect-settings.js";
import { callerFile } from "../components/call-site.js";
import type { Class, Provider } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { NodeKind } from "../flow/ast.js";
import type { Milliseconds } from "../units/index.js";
import type { UncompactedTurns } from "../compaction/compaction.decorator.js";
import type { WorkflowDefaults } from "../flow/decorators/workflow.js";
import type { ExecutionContextClass, TenantContextClass } from "../flow/context/context-values.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import type { ObserverClass } from "../core/observer-hooks.js";
import type { MeshOptions } from "../mesh/mesh-options.js";
import type { RetentionOptions } from "./retention.js";

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
  /** Every `@Budget` of the application (`config/budget.config.ts`). */
  readonly budgets?: readonly Class[];
  /**
   * The observers (`implements OnExecutionEnd, OnToolEnd, …`, `@Injectable`), the only place they
   * are registered: one instance each, called for every execution of the application — child
   * executions included (filter by `event.workflow.name`). None listed → no observer is called.
   */
  readonly observers?: readonly ObserverClass[];
  /**
   * The project's readiness checks (#300): `@HealthCheck` classes (`implements HealthCheckHandler`),
   * the only place they are listed — created by the container, run by `app.checkReadiness()` each
   * under its own `timeout`, besides the framework's own (the stores, the model providers' circuit
   * breakers, the recovery loop).
   */
  readonly healthChecks?: readonly Class[];
  /**
   * How long `app.close()` (and SIGTERM / SIGINT) takes at most (#265 S51): the running executions,
   * interrupted `min(seconds(5), 20 %)` of it before its end (#367 S3: the grace for their step
   * bodies), stay `running` for another instance. Default `seconds(25)` — under the 30 s lease.
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
   * How many applications one call chain of the mesh may pass through (#398), this one included: an
   * A2A or MCP request whose envelope already lists `maxMeshHops` applications is refused before it
   * runs (`HopsLimitExceededError`, `limit.hops`) — as is one whose chain already passed through
   * this application's start (`MeshLoopDetectedError`, `limit.mesh-loop`). A whole number from 1
   * (`[limits.max-mesh-hops-invalid]`); default 8.
   */
  readonly maxMeshHops?: number;
  /**
   * The application's identity in the mesh (#398 PR 2): its `signingKey` field (envelopes and run
   * reports signed, JWS `EdDSA`) and the `peers` whose signatures it verifies (each a `verifyKey`
   * field); how long trusted requests' answers are kept is `retention.meshAnswers`. A request's budget, deadline,
   * origin and idempotency key are honoured only for an authenticated peer with a valid signature.
   */
  readonly mesh?: MeshOptions;
  /**
   * What the application serves to other applications (#398 PR 3): its `@A2AExpose` and
   * `@McpExpose` classes — `a2aHttpListener` serves only a listed one
   * (`[application.expose-unlisted]`), and `agboss describe --json` lists them as exported contracts.
   */
  readonly exposes?: readonly Class[];
  /**
   * How much its A2A skills take as files (#859): `maxFileSize`, `maxTotalFileSize`, `maxFiles`,
   * `allowedMediaTypes`, `allowedFileOrigins` — each skill's `@A2AExpose({ skills: { [id]: { files }
   * } })` over it, field by field; `[a2a.file-options-invalid]`. A total above 64 KB without an
   * `A2AFileRepository` listed warns `[a2a.inline-files-without-store]`, above 256 KB it is
   * `[a2a.file-store-required]`. How long files are kept is `retention.a2aFiles`.
   */
  readonly a2aFiles?: A2AFileOptions;
  /**
   * How long each automatic undo action may run (#340): an `@Action({ compensateWith })` undone
   * because no path could — its finished branches when a join fails — runs with a clean-up
   * `executionContext.signal` that aborts after this (and on a lost lease or the app's stop), not
   * the execution's; the wait for the launch's steps still running before the undo has the same
   * bound. Default `seconds(15)`.
   */
  readonly compensationTimeout?: Milliseconds;
  /**
   * How long each kind of row the application keeps stays (#834): pause records, execution
   * records, the audit log, cost ledger entries, fenced effects, outbound calls, mesh answers and
   * A2A tasks — the one place a retention is set, `[application.retention-invalid]`. See
   * `RetentionOptions`.
   */
  readonly retention?: RetentionOptions;
  /**
   * The fenced effects of the application's steps (#500, `FencedEffectRepository`): the largest
   * result stored (`maxResultSize`, default `kilobytes(64)`, `[application.fenced-effects-invalid]`);
   * how long results and marks are kept is `retention.fencedEffects`.
   */
  readonly fencedEffects?: FencedEffectOptions;
  /**
   * The calls that leave the system (#505, `OutboundCalls`): the largest request and result
   * (default `kilobytes(64)`) and the bound of an attempt in flight —
   * `[application.outbound-calls-invalid]`; how long an ended intent is kept is
   * `retention.outboundCalls`.
   */
  readonly outboundCalls?: OutboundCallOptions;
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
   * The `@Compaction` of every agent and model router of every workflow (#120 PR 3): one setting —
   * a workflow's, an agent's or a router's own wins. None anywhere → no summaries.
   */
  readonly compaction?: Class;
  /**
   * How many recent turns every agent and model router sees in full (#120 PR 3; default 5,
   * `TurnLimit.ALL` = every turn) — a workflow's, an agent's or a router's own wins.
   */
  readonly uncompactedTurns?: UncompactedTurns;
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
   * The application's idempotency key (#825): names a `Secret` field of the environment used only
   * for business-key fingerprints — `HMAC(HMAC(key, "agboss/fingerprint/v1"), canonical JSON)` of what
   * a fenced effect or a call under a business key does — the same on every instance, never
   * guessable from a stored row. Required as soon as the application can make a business key (a
   * component reaches `OutboundCalls` or a fenced-effect store through its `deps`:
   * `[application.idempotency-key-required]`); never the PII key or a provider's
   * (`[application.idempotency-key-shared]`). `testWith` gives it a test key when its variable is not set.
   */
  readonly idempotencyKeyField?: SecretFieldOf<TEnvironment>;
  /**
   * The idempotency key the application rotates from (#825): while named, a fingerprint is compared
   * under both keys — a call recorded before the rotation and retried after it is recognised, never
   * a conflict — and stored under `idempotencyKeyField`'s. Remove it once no intent recorded under
   * it can be retried: what is left of it is then a conflict (fail closed), never a second call.
   */
  readonly previousIdempotencyKeyField?: SecretFieldOf<TEnvironment>;
  /**
   * Defaults of every workflow (#261): merged field by field under each workflow's own `defaults`
   * — the most specific level that sets a field wins (component over workflow over application).
   */
  readonly defaults?: WorkflowDefaults;
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
  readonly source?: string;
}

const applications = new WeakMap<Class, ApplicationDeclaration>();

/** The applications that list each workflow, as they are declared (loaded modules only). */
const listedIn = new WeakMap<Class, Class[]>();

export function Application<TEnvironment>(options: ApplicationOptions<TEnvironment>) {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    // kept as the application's options: the contract's field types are a compile-time check only
    const declared = options as ApplicationOptions;
    applications.set(
      value,
      source === undefined ? { options: declared } : { options: declared, source },
    );
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
  throw new ComponentError({ message: `${where} takes an @Application class: ${fix}` });
}

/** The applications loaded so far that list `workflow` (the CLI's commands on one workflow, eval). */
export const applicationsListing = (workflow: Class): readonly Class[] =>
  listedIn.get(workflow) ?? [];
