import type { Class } from "../components/injection.js";
import type { ExecutionContextValues } from "../flow/context/context-values.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { AssembledPii } from "./assembly.js";
import { isCustomPolicy } from "./pii-policy.decorator.js";
import { piiPolicyMetaOf } from "./policy-checks.js";
import { policyKeysOf } from "./policy-keys.js";
import { PiiPolicySet, type PreviousPiiKeys, type SensitiveValue } from "./policy-set.js";
import { runtimePolicyOf, type ModelDetection, type RuntimePiiPolicy } from "./runtime-policy.js";
import { sensitiveValuesOf } from "./sensitive-values.js";
import { observabilityMaskOf, type ObservabilityMask } from "./observability-mask.js";

/**
 * A workflow's PII policies at run time (#120): the instances from the container with their keys
 * (each `secret` and `previousSecret` read from its process variable when the app starts — a missing one fails the
 * start, naming it), the set at each agent's and router's model, and the observability set. As a
 * child (#1150, `inChain`) it adds the policies of the workflows above it: observability masks with
 * the whole chain, the models with the chain less the workflow's and the element's excludes.
 */
export interface PiiRuntime {
  /** The policies at an agent's or a router's model (application + chain + workflow + own − excluded). */
  readonly policiesOf: (element: string) => PiiPolicySet;
  /** Logs, traces, events and the record: the application's, the chain's and the workflow's lists. */
  readonly observability: ObservabilityMask;
  /**
   * What `observability` masks with — never less for an exclusion — and what a child of this
   * workflow inherits (#1150).
   */
  readonly observed: PiiPolicySet;
  /**
   * The application's, the chain's and the workflow's lists less the workflow's excludes: what a
   * model that belongs to no agent or router reads through — a reply interpreter's (#267 PR 3, a
   * channel role's) and a compaction's (#120 PR 3, shared by its readers).
   */
  readonly workflowPolicies: PiiPolicySet;
  /** The values of an execution's contexts marked `sensitive` (#120 AC13). */
  readonly contextValuesOf: (contexts: ExecutionContextValues) => readonly SensitiveValue[];
  /** The key of the tokens of `sensitive` fields. */
  readonly fieldKey: string;
  /** The key `fieldKey` rotates from (`previousPiiSecret`): a token made under it is kept. */
  readonly previousFieldKey?: string | undefined;
  /**
   * Whether `fieldKey` is the instance's own (no `piiKeyField`, S94): each root execution then
   * makes its field tokens with a key of its own, kept in its state (#334).
   */
  readonly isInstanceKey: boolean;
  /**
   * This workflow under the policies of the workflows above it (#1150): `inherited` added to every
   * set — its observability whole, its models less what the workflow and each element exclude.
   * Added up: a chained runtime's `inChain` adds to what it already inherits.
   */
  readonly inChain: (inherited: readonly RuntimePiiPolicy[]) => PiiRuntime;
  /** The policies the workflow declares, none inherited: what its `configHash` covers (#1150). */
  readonly declared: PiiRuntime;
  /** A policy this workflow's runtime made, by its `@PiiPolicy` name; `undefined` for none. */
  readonly policyNamed: (name: string) => RuntimePiiPolicy | undefined;
}

/** What the runtime is built from: the container, the process, models and the contexts. */
export interface PiiRuntimeParts {
  readonly resolve: (cls: Class) => unknown;
  readonly processEnv: NodeJS.ProcessEnv;
  /** The model detection of a policy on its `model` model. */
  readonly detectionOf: (policy: string, model: string) => ModelDetection;
  readonly contexts: Pick<RuntimeContexts, "tenantContext" | "executionContext">;
  /**
   * The application's key (`@Application({ piiKeyField })`, #120): tokens no policy key covers —
   * sensitive fields, a project's detectors, a policy without its own key.
   */
  readonly fieldKey: string;
  /** The key `fieldKey` rotates from (`@DatabaseStorage({ previousPiiSecret })`); none when unset. */
  readonly previousFieldKey?: string | undefined;
  /** The key is the instance's own (S94); absent = the application's (or a test's). */
  readonly isInstanceKey?: boolean;
}

function runtimePoliciesOf(
  pii: AssembledPii,
  parts: PiiRuntimeParts,
): ReadonlyMap<Class, RuntimePiiPolicy> {
  return new Map(
    pii.classes.flatMap((cls) => {
      const meta = piiPolicyMetaOf(cls);
      if (meta === undefined) return [];
      const model = isCustomPolicy(meta) ? undefined : meta.model;
      const policy = runtimePolicyOf({
        meta,
        instance: parts.resolve(cls),
        ...policyKeysOf(meta, parts),
        ...(model === undefined ? {} : { detection: parts.detectionOf(meta.name, model) }),
      });
      return [[cls, policy] as const];
    }),
  );
}

/** The element of a node id: a launch's copy (`critic-agent#2`) is its agent's. */
const elementOfNode = (nodeId: string): string => nodeId.split("#")[0] ?? nodeId;

const namesOf = (classes: readonly Class[]): ReadonlySet<string> =>
  new Set(classes.map((cls) => piiPolicyMetaOf(cls)?.name ?? cls.name));

/** The keys the application's rotates from (`previousPiiSecret`): the same for tokens and every digest. */
const previousOf = (parts: PiiRuntimeParts): PreviousPiiKeys => ({
  fieldKey: parts.previousFieldKey,
  rootKey: parts.previousFieldKey,
});

/** One set of `sets`' policies, each once by name (the first kept), on the application's key. */
const unionOf = (
  parts: PiiRuntimeParts,
  ...lists: (readonly RuntimePiiPolicy[])[]
): PiiPolicySet => {
  const byName = new Map<string, RuntimePiiPolicy>();
  for (const policy of lists.flat()) if (!byName.has(policy.name)) byName.set(policy.name, policy);
  return new PiiPolicySet(
    [...byName.values()],
    parts.fieldKey,
    [],
    parts.fieldKey,
    previousOf(parts),
  );
};

/** What a runtime is made of: its own sets, and what a chain removes at its models. */
interface OwnPii {
  readonly policies: ReadonlyMap<Class, RuntimePiiPolicy>;
  readonly elementSet: (element: string) => PiiPolicySet | undefined;
  readonly observed: PiiPolicySet;
  readonly model: PiiPolicySet;
  readonly none: PiiPolicySet;
  readonly isDeclared: boolean;
  /** The names an element (or, `undefined`, the workflow) removes at its models. */
  readonly excludedAt: (element: string | undefined) => ReadonlySet<string>;
  readonly parts: PiiRuntimeParts;
}

/** Each element's set under `inherited` (#708: one no list names reads the workflow's, never none). */
function elementSetsOf(
  own: OwnPii,
  inherited: readonly RuntimePiiPolicy[],
  workflowPolicies: PiiPolicySet,
): (element: string) => PiiPolicySet {
  const byElement = new Map<string, PiiPolicySet>();
  const setOf = (element: string): PiiPolicySet => {
    const base = own.elementSet(element) ?? own.elementSet(elementOfNode(element));
    if (base === undefined)
      return own.isDeclared || inherited.length > 0 ? workflowPolicies : own.none;
    if (inherited.length === 0) return base;
    const removed = own.excludedAt(elementOfNode(element));
    return unionOf(
      own.parts,
      base.policies,
      inherited.filter((policy) => !removed.has(policy.name)),
    );
  };
  return (element) => {
    const known = byElement.get(element) ?? setOf(element);
    byElement.set(element, known);
    return known;
  };
}

function runtimeOf(
  own: OwnPii,
  inherited: readonly RuntimePiiPolicy[],
  declared?: PiiRuntime,
): PiiRuntime {
  const { parts } = own;
  const removed = own.excludedAt(undefined);
  const atModels = inherited.filter((policy) => !removed.has(policy.name));
  const observed =
    inherited.length === 0 ? own.observed : unionOf(parts, own.observed.policies, inherited);
  const workflowPolicies =
    inherited.length === 0 ? own.model : unionOf(parts, own.model.policies, atModels);
  const byName = new Map([...own.policies.values()].map((policy) => [policy.name, policy]));
  const runtime: PiiRuntime = {
    policiesOf: elementSetsOf(own, inherited, workflowPolicies),
    observability: observabilityMaskOf(observed, parts.contexts),
    observed,
    workflowPolicies,
    fieldKey: parts.fieldKey,
    previousFieldKey: parts.previousFieldKey,
    isInstanceKey: parts.isInstanceKey === true,
    contextValuesOf: (contexts) =>
      sensitiveValuesOf([
        { type: parts.contexts.tenantContext, values: contexts.tenant },
        { type: parts.contexts.executionContext, values: contexts.execution },
      ]),
    inChain: (more) => runtimeOf(own, [...inherited, ...more], declared ?? runtime),
    get declared() {
      return declared ?? runtime;
    },
    policyNamed: (name) => byName.get(name),
  };
  return runtime;
}

/** What a workflow's own sets are made of, from its assembly. */
function ownPiiOf(pii: AssembledPii, parts: PiiRuntimeParts): OwnPii {
  const policies = runtimePoliciesOf(pii, parts);
  const setOf = (classes: readonly Class[]): PiiPolicySet =>
    new PiiPolicySet(
      classes.flatMap((cls) => policies.get(cls) ?? []),
      parts.fieldKey,
      [],
      parts.fieldKey,
      previousOf(parts),
    );
  const sets = new Map([...pii.byElement].map(([name, classes]) => [name, setOf(classes)]));
  const workflowExcluded = namesOf(pii.excludes.workflow);
  const elementExcluded = new Map(
    [...pii.excludes.byElement].map(([name, classes]) => [
      name,
      new Set([...workflowExcluded, ...namesOf(classes)]),
    ]),
  );
  return {
    policies,
    elementSet: (element) => sets.get(element),
    observed: setOf(pii.observability),
    model: setOf(pii.model),
    none: setOf([]),
    isDeclared: true,
    excludedAt: (element) =>
      element === undefined ? workflowExcluded : (elementExcluded.get(element) ?? workflowExcluded),
    parts,
  };
}

/** A workflow that lists no policy anywhere: every set empty. */
const NO_PII = {
  byElement: new Map(),
  observability: [],
  model: [],
  excludes: { workflow: [], byElement: new Map() },
  chains: [],
  classes: [],
  detectors: [],
} satisfies AssembledPii;

/** The runtime of a workflow's policies; none listed anywhere → every set is empty. */
export function piiRuntimeOf(pii: AssembledPii | undefined, parts: PiiRuntimeParts): PiiRuntime {
  const own = ownPiiOf(pii ?? NO_PII, parts);
  return runtimeOf(pii === undefined ? { ...own, isDeclared: false } : own, []);
}
