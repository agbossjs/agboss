import type { Infrastructure } from "../infrastructure/contracts.js";
import type { RecoverySweep } from "../infrastructure/recovery.js";
import type { StepCapacity } from "../app/step-slots.js";
import type { ModelProviderType } from "../models/model-provider.decorator.js";
import type { HealthCheckHandler, HealthCheckMeta, HealthReport } from "./health-check.js";

/** The two probes of an application instance (#300): what `app.checkLiveness()` / `app.checkReadiness()` call. */
export interface ApplicationHealth {
  /** No network, no database: the instance is not stopping and its recovery loop is not stuck. */
  checkLiveness(): Promise<HealthReport>;
  /** Liveness's components, every store's `ping()`, the model providers' breakers, the project's checks. */
  checkReadiness(): Promise<HealthReport>;
}

/** A project's `@HealthCheck`: what it recorded and its instance, created by the container. */
export interface ProjectHealthCheck {
  readonly meta: HealthCheckMeta;
  readonly handler: HealthCheckHandler;
}

/** What the probes of one instance read. */
export interface HealthSources {
  /** The application's name: its own component in the report. */
  readonly application: string;
  /** Whether `app.close()` was called. */
  readonly isStopping: () => boolean;
  readonly sweep: RecoverySweep;
  /** The stores, the clock (every timeout and duration) and the rate limits (the breakers' state). */
  readonly infrastructure: Infrastructure;
  /** The application's model providers: its listed ones, else the built-ins. */
  readonly modelProviders: readonly ModelProviderType[];
  readonly healthChecks: readonly ProjectHealthCheck[];
  /** The instance's step slots (#332); absent = no cap, no `step-slots` component. */
  readonly stepSlots?: StepCapacity | undefined;
}
