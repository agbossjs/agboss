import type { ApplicationContainer, ContainerOptions } from "../components/container/container.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import { observabilityMaskOf, type ObservabilityMask } from "../pii/observability-mask.js";
import { PiiPolicySet } from "../pii/policy-set.js";
import { piiRuntimeOf, type PiiRuntime } from "../pii/runtime.js";
import type { ModelDetection } from "../pii/runtime-policy.js";
import { resolveListed } from "./application-container.js";
import { applicationPseudonymKeyOf, type ApplicationKeySource } from "../pii/application-key.js";
import { newPiiKey } from "../pii/tokens.js";
import { variableOfSecretRef } from "../environments/secret.js";
import type { AssembledApplication } from "./assemble.js";

/** The key an instance makes PII tokens with, and whether it is its own (S94). */
export interface ApplicationPiiKey {
  readonly key: string;
  /**
   * No `piiKeyField` set and none needed: a key of this instance (its logs and traces), each root
   * execution's tokens on a key of its own (#334) — `[application.pii-instance-key]`.
   */
  readonly isInstanceKey: boolean;
}

/**
 * The application's PII key (#120): its `piiKeyField`, the test's key under `testWith`, else
 * a key of the instance (S94: the start goes on, with a warning) — unless a policy needs the
 * application's, which fails the start.
 */
export function applicationPiiKeyOf(
  assembled: AssembledApplication,
  source: Pick<ApplicationKeySource, "environment" | "env" | "fallback">,
): ApplicationPiiKey {
  const policies = [...new Set(assembled.workflows.flatMap((w) => w.pii?.classes ?? []))];
  const key = applicationPseudonymKeyOf({
    ...source,
    application: assembled.name,
    field: assembled.piiKeyField,
    secretVariable:
      assembled.storage?.database?.meta.piiSecret === undefined
        ? undefined
        : variableOfSecretRef(assembled.storage.database.meta.piiSecret),
    policies,
  });
  return key === undefined
    ? { key: newPiiKey(), isInstanceKey: true }
    : { key, isInstanceKey: false };
}

/** The application's own log never calls a model: a model detection is not built for it. */
const noDetection = (): ModelDetection => () =>
  Promise.reject(new Error("the application's log masks without a model"));

/**
 * What the application's own log and audit log are masked with (#120 AC7, #1130): what belongs
 * to no one run — an observer's failure, a takeover, a startup line — is masked by the UNION of
 * every policy the application and its workflows list for observability (fail closed: never
 * weaker than any run's own mask). Formats only, never a model. Each workflow adds its policies
 * as it is built (`withWorkflow`); before that the application's own lists mask.
 */
export interface ApplicationPiiMask extends ObservabilityMask {
  /** The union grows by a built workflow's observability policies. */
  readonly withWorkflow: (pii: Pick<PiiRuntime, "observed"> | undefined) => void;
}

/** One set of every policy of `sets`, each once (by name), on the first set's field key. */
const unionOf = (sets: readonly PiiPolicySet[]): PiiPolicySet => {
  const byName = new Map(sets.flatMap((set) => set.policies).map((each) => [each.name, each]));
  return new PiiPolicySet([...byName.values()], sets[0]?.fieldKey ?? "");
};

/** The application's mask (#1130): its own `piiPolicies` at first, the union once workflows are added. */
export function applicationPiiMaskOf(
  assembled: AssembledApplication,
  application: ApplicationContainer,
  options: ContainerOptions,
  parts: {
    readonly processEnv: NodeJS.ProcessEnv;
    readonly fieldKey: string;
    readonly contexts: RuntimeContexts;
  },
): ApplicationPiiMask {
  const classes = assembled.piiPolicies;
  const created = resolveListed(application, options, classes);
  const instances = new Map(classes.map((cls, index) => [cls, created[index]]));
  const excludes = { workflow: [], byElement: new Map() };
  const pii = {
    ...{ byElement: new Map(), observability: classes, model: classes, excludes, chains: [] },
    ...{ classes, detectors: [] },
  };
  const own = piiRuntimeOf(pii, {
    resolve: (cls) => instances.get(cls),
    processEnv: parts.processEnv,
    detectionOf: noDetection,
    contexts: parts.contexts,
    fieldKey: parts.fieldKey,
  });
  const sets: PiiPolicySet[] = [own.observed];
  let mask = own.observability;
  return {
    value: (data) => mask.value(data),
    text: (line) => mask.text(line),
    traceData: (data) => mask.traceData(data),
    withWorkflow: (workflow) => {
      if (workflow === undefined) return;
      // its observability set: never less for a workflow's excludes (#1150)
      sets.push(workflow.observed);
      mask = observabilityMaskOf(unionOf(sets), parts.contexts);
    },
  };
}
