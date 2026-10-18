import type { ApplicationContainer, ContainerOptions } from "../components/container/container.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";
import { piiRuntimeOf } from "../pii/runtime.js";
import type { ModelDetection } from "../pii/runtime-policy.js";
import { resolveListed } from "./application-container.js";
import { applicationPseudonymKeyOf, type ApplicationKeySource } from "../pii/application-key.js";
import { newPiiFieldKey } from "../app/pii-parts.js";
import type { AssembledApplication } from "./assemble.js";

/**
 * The application's PII key (#120): its `pseudonymKey` field, the test's key under `testWith`, else
 * a key of the instance — unless a policy needs the application's, which fails the start.
 */
export function applicationPiiKeyOf(
  assembled: AssembledApplication,
  source: Pick<ApplicationKeySource, "environment" | "env" | "fallback">,
): string {
  const policies = [...new Set(assembled.workflows.flatMap((w) => w.pii?.classes ?? []))];
  const key = applicationPseudonymKeyOf({
    ...source,
    application: assembled.name,
    field: assembled.pseudonymKey,
    policies,
  });
  return key ?? newPiiFieldKey();
}

/** The application's own log never calls a model: a model detection is not built for it. */
const noDetection = (): ModelDetection => () =>
  Promise.reject(new Error("the application's log masks without a model"));

/** What the application's own log is masked with (#120 AC7): its `piiPolicies`, formats only. */
export function applicationPiiMaskOf(
  assembled: AssembledApplication,
  application: ApplicationContainer,
  options: ContainerOptions,
  parts: {
    readonly processEnv: NodeJS.ProcessEnv;
    readonly fieldKey: string;
    readonly contexts: RuntimeContexts;
  },
): ObservabilityMask {
  const classes = assembled.piiPolicies;
  const created = resolveListed(application, options, classes);
  const instances = new Map(classes.map((cls, index) => [cls, created[index]]));
  const pii = { byElement: new Map(), observability: classes, classes, detectors: [] };
  return piiRuntimeOf(pii, {
    resolve: (cls) => instances.get(cls),
    processEnv: parts.processEnv,
    detectionOf: noDetection,
    contexts: parts.contexts,
    fieldKey: parts.fieldKey,
  }).observability;
}
