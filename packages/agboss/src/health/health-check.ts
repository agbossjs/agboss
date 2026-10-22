import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import { kindSuffixProblem, NameKind } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { Milliseconds } from "../units/index.js";

/**
 * Health checks (#300) — what the root import carries of them: the report's vocabulary (what
 * `app.checkLiveness()` and `app.checkReadiness()` report: a status per component, the worst of
 * them for the instance), the `@HealthCheck` component with its result builders, and the rules of
 * `@Application({ healthChecks })`. Running the probes is loaded on first use
 * (`application-health.ts`). A project's server exposes the two methods; the framework opens no
 * endpoint.
 */

/** How a component (or the instance, the worst of its components) is. */
export enum HealthStatus {
  /** It works. */
  Healthy = "healthy",
  /** It works with less: an open circuit breaker of a model provider, a project check's own call. */
  Degraded = "degraded",
  /** It does not work: the instance is stopping, a store is unreachable, a check failed or timed out. */
  Unhealthy = "unhealthy",
}

/** What a component of the report is. */
export enum HealthComponentKind {
  /** The application instance itself: `Unhealthy` from `app.close()` on. */
  Application = "application",
  /** The recovery sweep (#265): `Unhealthy` when its last sweep is older than three intervals. */
  RecoveryLoop = "recovery-loop",
  /** One of the instance's stores (#265 contracts, the checkpoint saver): its `ping()`. */
  Store = "store",
  /** A model provider (#266): its circuit breaker's state, never a model call. */
  ModelProvider = "model-provider",
  /** A project's `@HealthCheck`. */
  Project = "project",
  /**
   * The instance's step slots (#332, `@Application({ maxConcurrentSteps })`, component
   * `step-slots`): `Degraded` while every slot is busy; reported only when the cap is set.
   */
  StepSlots = "step-slots",
}

/** One component of a report. */
export interface HealthComponentReport {
  /**
   * The application's name, `recovery-loop`, a store's class (`SqliteCostLedgerRepository`), a
   * model provider's name or a `@HealthCheck`'s name.
   */
  readonly name: string;
  readonly kind: HealthComponentKind;
  readonly status: HealthStatus;
  /** Why it is not `Healthy`: a check's own reason, an error's message, `timed out after 2 s`. */
  readonly reason?: string;
  /** How long its check took, on the application's `Clock`. */
  readonly duration: Milliseconds;
}

/** What a probe reports: the worst component's status and every component. */
export interface HealthReport {
  readonly status: HealthStatus;
  readonly components: readonly HealthComponentReport[];
}

declare const healthCheckResult: unique symbol;

/**
 * What a `@HealthCheck`'s `check()` resolves with (#300): built only with
 * `HealthCheckResult.healthy()`, `.degraded({ reason })` or `.unhealthy({ reason })` — branded and
 * frozen, so a plain object does not compile.
 */
interface BuiltHealthCheckResult {
  readonly [healthCheckResult]: true;
}

/** The checked dependency works. */
export interface HealthyCheckResult extends BuiltHealthCheckResult {
  readonly status: HealthStatus.Healthy;
}

/** The checked dependency works with less, or is not working: `reason` says why. */
export interface FailedHealthCheckResult extends BuiltHealthCheckResult {
  readonly status: HealthStatus.Degraded | HealthStatus.Unhealthy;
  readonly reason: string;
}

/** A health check's result: `HealthCheckResult.healthy()` / `.degraded(…)` / `.unhealthy(…)`. */
export type HealthCheckResult = HealthyCheckResult | FailedHealthCheckResult;

/** `HealthCheckResult.degraded({ reason })` / `.unhealthy({ reason })` — why it is not healthy. */
export interface HealthCheckResultOptions {
  readonly reason: string;
}

const failed = (
  status: HealthStatus.Degraded | HealthStatus.Unhealthy,
  options: HealthCheckResultOptions,
): FailedHealthCheckResult =>
  Object.freeze({ status, reason: options.reason }) as FailedHealthCheckResult;

/** The only way to build a health check's result (#300 S1, like `JudgeVerdict`). */
export const HealthCheckResult = {
  /** The dependency works. */
  healthy(): HealthyCheckResult {
    return Object.freeze({ status: HealthStatus.Healthy }) as HealthyCheckResult;
  },
  /** It works with less (a slow replica, a fallback in use): the instance stays ready, degraded. */
  degraded(options: HealthCheckResultOptions): FailedHealthCheckResult {
    return failed(HealthStatus.Degraded, options);
  },
  /** It does not work: the instance is not ready. */
  unhealthy(options: HealthCheckResultOptions): FailedHealthCheckResult {
    return failed(HealthStatus.Unhealthy, options);
  },
} as const;

/** What a `@HealthCheck` class implements. */
export interface HealthCheckHandler {
  /** Checks one dependency: `HealthCheckResult.healthy()`, `.degraded({ reason })`, `.unhealthy({ reason })`. */
  readonly check: () => Promise<HealthCheckResult>;
}

/** `@HealthCheck` options. */
export interface HealthCheckOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Ends with `-health-check` (`crm-health-check`), unique in the application. */
  readonly name: string;
  /** How long `check()` may take (`seconds(2)`): past it the check is `Unhealthy`, timed out. */
  readonly timeout: Milliseconds;
  /** The constructor's dependencies, in order (compiler-checked), injected by the container. */
  readonly deps?: TDeps;
}

/** What `@HealthCheck` records about a class. */
export interface HealthCheckMeta {
  readonly name: string;
  readonly timeout: Milliseconds;
  readonly deps: readonly Token[];
}

/**
 * A project's own readiness check: `@HealthCheck({ name, timeout, deps? })` on a class that
 * `implements HealthCheckHandler`, created by the application's container like any component and
 * listed only in `@Application({ healthChecks })`. `app.checkReadiness()` runs every one under its
 * own `timeout` on the application's `Clock`; one that throws or passes it is `Unhealthy` in the
 * report — the probe never rejects.
 */
export function HealthCheck<const TDeps extends readonly Token[] = []>(
  options: HealthCheckOptions<TDeps>,
) {
  return <TClass extends new (...args: ResolvedAll<TDeps>) => HealthCheckHandler>(
    value: TClass,
  ): TClass => {
    const { name, timeout } = options;
    recordComponent(value, {
      kind: "health-check",
      meta: { name, timeout, deps: options.deps ?? [] },
    });
    return value;
  };
}

/** What `@HealthCheck` recorded on a class; `undefined` when it is not a health check. */
export function healthCheckOf(cls: Class): HealthCheckMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "health-check" ? component.meta : undefined;
}

const classNameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** What the rules read of the application: its name and its health checks. */
export interface HealthCheckList {
  readonly name: string;
  readonly healthChecks?: readonly Class[];
}

/** One listed class: decorated, and its name with its kind. */
function listedViolations(application: string, cls: Class): RuleViolation[] {
  const meta = healthCheckOf(cls);
  if (meta === undefined) {
    return [
      violation(
        "health.not-a-health-check",
        `${classNameOf(cls)} in ${application}'s healthChecks has no @HealthCheck({ name, timeout }) decorator`,
        [application],
      ),
    ];
  }
  const problem = kindSuffixProblem(meta.name, NameKind.HealthCheck);
  return problem === undefined ? [] : [violation(problem.code, problem.message, [application])];
}

/** Two listed checks with one name: their reports could not be told apart. */
function duplicateViolations(application: string, checks: readonly Class[]): RuleViolation[] {
  const byName = new Map<string, Class[]>();
  for (const cls of checks) {
    const name = healthCheckOf(cls)?.name;
    if (name !== undefined) byName.set(name, [...(byName.get(name) ?? []), cls]);
  }
  return [...byName].flatMap(([name, classes]) =>
    classes.length < 2
      ? []
      : [
          violation(
            "health.duplicate-name",
            `"${name}" names ${classes.map(classNameOf).join(" and ")} in ${application}'s healthChecks — give each its own name`,
            [application],
          ),
        ],
  );
}

/**
 * The rules of `@Application({ healthChecks })`, at assembly with the application's other rules:
 * every listed class is a `@HealthCheck` (`[health.not-a-health-check]`), its `name` ends with
 * `-health-check` (`[name.kind-suffix]`) and is the only one of its name (`[health.duplicate-name]`).
 */
export function healthCheckRuleViolations(options: HealthCheckList): RuleViolation[] {
  const checks = options.healthChecks ?? [];
  return [
    ...checks.flatMap((cls) => listedViolations(options.name, cls)),
    ...duplicateViolations(options.name, checks),
  ];
}

/** The listed classes the container creates: the decorated ones (the others fail the rules above). */
export const decoratedHealthChecksOf = (checks: readonly Class[] | undefined): readonly Class[] =>
  (checks ?? []).filter((cls) => healthCheckOf(cls) !== undefined);
