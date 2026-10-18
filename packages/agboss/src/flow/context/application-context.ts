import { hostname } from "node:os";
import type { Environment } from "../generated-types.js";

/**
 * The application level (#261): an immutable description of the running application instance — one
 * object for the whole instance, created by the framework at start, never by the project. It holds
 * no services and no mutable state. A component outside an execution takes it
 * (`deps: [ApplicationContext]`); inside one it is `executionContext.tenant.application`.
 */

/** The host the instance runs on (as Spring Boot exposes it). */
export interface HostContext {
  readonly hostname: string;
  readonly pid: number;
  /** `process.platform`: `linux`, `darwin`, … */
  readonly platform: string;
  /** `process.version`: `v22.11.0`. */
  readonly runtimeVersion: string;
}

/**
 * The running application: the type and the DI token (`deps: [ApplicationContext]`). Its
 * `environment` is typed by the application's contract through the generated `.agboss/types.d.ts`.
 */
export abstract class ApplicationContext {
  /** `@Application({ name })`. */
  abstract readonly name: string;
  /** `@Application({ version })`: the release version. */
  abstract readonly version: string;
  /** This instance's id: the holder of its leases (#265). */
  abstract readonly instanceId: string;
  /** When this instance started, from the framework's clock. */
  abstract readonly startedAt: Date;
  /** The chosen environment's name (`prod` for `environments/prod.environment.ts`). */
  abstract readonly environmentName: string;
  /** The chosen environment's values, typed by the contract (`@Application({ environment })`). */
  abstract readonly environment: Environment;
  abstract readonly host: HostContext;
}

/** What the framework builds an application context from (internal). */
export interface ApplicationContextValues {
  readonly name: string;
  readonly version: string;
  readonly instanceId: string;
  readonly startedAt: Date;
  readonly environmentName: string;
  readonly environment: Environment;
}

/** The framework's application context: frozen data, the same object for the whole instance. */
class FrozenApplicationContext extends ApplicationContext {
  readonly name: string;
  readonly version: string;
  readonly instanceId: string;
  readonly startedAt: Date;
  readonly environmentName: string;
  readonly environment: Environment;
  readonly host: HostContext;

  constructor(values: ApplicationContextValues, host: HostContext) {
    super();
    this.name = values.name;
    this.version = values.version;
    this.instanceId = values.instanceId;
    this.startedAt = new Date(values.startedAt.getTime());
    this.environmentName = values.environmentName;
    this.environment = Object.freeze({ ...values.environment });
    this.host = Object.freeze({ ...host });
    Object.freeze(this);
  }
}

/** The host this process runs on. */
export const currentHost = (): HostContext => ({
  hostname: hostname(),
  pid: process.pid,
  platform: process.platform,
  runtimeVersion: process.version,
});

/** The application context of an instance (internal: the framework creates it once, at start). */
export const applicationContextOf = (
  values: ApplicationContextValues,
  host: HostContext = currentHost(),
): ApplicationContext => new FrozenApplicationContext(values, host);
