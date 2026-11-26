import type { ApplicationContainer, ContainerOptions } from "../components/container/container.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import { observabilityMaskOf, type ObservabilityMask } from "../pii/observability-mask.js";
import { PiiPolicySet } from "../pii/policy-set.js";
import { piiRuntimeOf, type PiiRuntime } from "../pii/runtime.js";
import type { ModelDetection } from "../pii/runtime-policy.js";
import { resolveListed } from "./application-container.js";
import { applicationPseudonymKeysOf, type ApplicationKeySource } from "../pii/application-key.js";
import { policiesTokenizing, tokenizeFieldsOf } from "../pii/tokenize-use.js";
import type { DtoClass } from "../dto/types.js";
import { toolDtosOf } from "./start-log.js";
import { newPiiKey } from "../pii/tokens.js";
import type { AssembledApplication } from "./assemble.js";

/** The key an instance makes PII tokens with, and whether it is its own (S94). */
export interface ApplicationPiiKey {
  readonly key: string;
  /**
   * No PII secret named and nothing tokenizes: a key of this instance (its logs and traces), each
   * root execution's field keys on one of its own (#334).
   */
  readonly isInstanceKey: boolean;
  /** The key `key` rotates from (`@DatabaseStorage({ previousPiiSecret })`): none when not rotating. */
  readonly previousKey?: string;
}

/** The DTOs that may carry a `sensitive` field: the contexts, the workflows' paths and the tools'. */
const dtosOf = (assembled: AssembledApplication): readonly DtoClass[] => [
  assembled.tenantContext,
  assembled.executionContext,
  ...assembled.workflows.flatMap((workflow) => [
    ...workflow.graph.dtos.values(),
    ...toolDtosOf(workflow),
  ]),
];

/** What makes tokens with the application's key: policies and DTO fields, by name (never a value). */
const tokenizingOf = (assembled: AssembledApplication): readonly string[] => {
  const policies = [...new Set(assembled.workflows.flatMap((w) => w.pii?.classes ?? []))];
  return [
    ...policiesTokenizing([...new Set([...assembled.piiPolicies, ...policies])]).map(
      (name) => `policy ${name}`,
    ),
    ...tokenizeFieldsOf(dtosOf(assembled)).map((field) => `field ${field}`),
  ];
};

/**
 * The application's PII key (#120, #1301): `@DatabaseStorage({ piiSecret })` (and the key it rotates
 * from), the test's key under `testWith` (never in production), else
 * a key of the instance for the logs — unless something tokenizes, which fails the start
 * (`[pii.secret-required]`).
 */
export function applicationPiiKeyOf(
  assembled: AssembledApplication,
  source: Pick<ApplicationKeySource, "env" | "fallback" | "isInstanceKeyAllowed">,
): ApplicationPiiKey {
  const meta = assembled.storage?.database?.meta;
  const keys = applicationPseudonymKeysOf({
    ...source,
    application: assembled.name,
    secret: meta?.piiSecret,
    previousSecret: meta?.previousPiiSecret,
    tokenizing: tokenizingOf(assembled),
  });
  return keys === undefined
    ? { key: newPiiKey(), isInstanceKey: true }
    : {
        key: keys.key,
        isInstanceKey: false,
        ...(keys.previousKey === undefined ? {} : { previousKey: keys.previousKey }),
      };
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
  return new PiiPolicySet(
    [...byName.values()],
    sets[0]?.fieldKey ?? "",
    [],
    sets[0]?.fieldKey ?? "",
    sets[0]?.previous,
  );
};

/** The application's mask (#1130): its own `piiPolicies` at first, the union once workflows are added. */
export function applicationPiiMaskOf(
  assembled: AssembledApplication,
  application: ApplicationContainer,
  options: ContainerOptions,
  parts: {
    readonly processEnv: NodeJS.ProcessEnv;
    readonly fieldKey: string;
    readonly previousFieldKey?: string | undefined;
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
    previousFieldKey: parts.previousFieldKey,
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
