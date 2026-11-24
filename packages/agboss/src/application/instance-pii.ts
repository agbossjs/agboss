import type { ApplicationContainer, ContainerOptions } from "../components/container/container.js";
import type { Class } from "../components/injection.js";
import type { Environment } from "../flow/generated-types.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import { frameworkLogOf, type FrameworkLog } from "../infrastructure/logger.js";
import type { Clock } from "../infrastructure/clock.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import { maskedLoggerOf } from "../pii/masked-logger.js";
import {
  applicationPiiKeyOf,
  applicationPiiMaskOf,
  type ApplicationPiiKey,
  type ApplicationPiiMask,
} from "./application-pii.js";
import type { AssembledApplication } from "./assemble.js";
import type { InstanceSeams } from "./instance-seams.js";

/** What an instance's PII key, mask and log are made from. */
export interface InstancePiiSources {
  readonly shared: ApplicationContainer;
  readonly container: ContainerOptions;
  readonly environment: Environment;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly seams: InstanceSeams;
  readonly contexts: RuntimeContexts;
  readonly clock: Clock;
  readonly infrastructure: Infrastructure;
}

/**
 * An instance's PII (#120, #1301): its key (a test's instances share a fixed one when the application
 * sets none, #334; a token with no key fails the start), the mask of what it logs, and its log — and
 * the `Logger` its own components inject, masked as that log is, so none writes past the policies.
 */
export function instancePiiOf(
  assembled: AssembledApplication,
  sources: InstancePiiSources,
): {
  readonly piiKey: ApplicationPiiKey;
  readonly mask: ApplicationPiiMask;
  readonly log: FrameworkLog;
} {
  const { shared, infrastructure, seams } = sources;
  const piiKey = applicationPiiKeyOf(assembled, {
    environment: sources.environment,
    env: sources.processEnv,
    fallback: seams.piiTestKey,
    isInstanceKeyAllowed: seams.piiInstanceKeys === true,
  });
  const piiParts = {
    processEnv: sources.processEnv,
    fieldKey: piiKey.key,
    previousFieldKey: piiKey.previousKey,
    contexts: sources.contexts,
  };
  const mask = applicationPiiMaskOf(assembled, shared, sources.container, piiParts);
  const text = (message: string): string => mask.text(message);
  const log = frameworkLogOf(infrastructure.logger, sources.clock, text);
  shared.instances.set(
    infrastructure.logger.constructor as Class,
    maskedLoggerOf(infrastructure.logger, text),
  );
  return { piiKey, mask, log };
}
