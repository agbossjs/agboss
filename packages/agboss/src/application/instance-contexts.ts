import { randomUUID } from "node:crypto";
import type { AppDepsOptions } from "../app/app-deps.js";
import { APP_DEFAULT_ENVIRONMENT } from "../environments/load.js";
import { NO_ENVIRONMENT_VALUES } from "../environments/resolve.js";
import { applicationContextOf } from "../flow/context/application-context.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { Clock } from "../infrastructure/clock.js";
import type { AssembledApplication } from "./assemble.js";
import type { InstanceSeams } from "./instance-seams.js";

/**
 * The instance's context levels (#261): its one `ApplicationContext` — name, version, its id,
 * when it started (the framework's clock), the profiles and the chosen environment and the host — and
 * the context classes the application declares.
 */
export function contextsOf(
  assembled: AssembledApplication,
  options: AppDepsOptions,
  seams: InstanceSeams,
  clock: Clock,
): RuntimeContexts {
  const application = applicationContextOf({
    name: assembled.name,
    version: assembled.version,
    instanceId: seams.instanceId ?? randomUUID(),
    startedAt: clock.now(),
    environmentName: options.environmentName ?? APP_DEFAULT_ENVIRONMENT,
    environment: options.environment ?? NO_ENVIRONMENT_VALUES,
    profiles: assembled.profiles,
  });
  const { tenantContext, executionContext } = assembled;
  return { application, tenantContext, executionContext };
}
