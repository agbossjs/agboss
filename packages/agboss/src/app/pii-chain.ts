import type { Class } from "../components/injection.js";
import type { GraphDeps } from "../graph/deps.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";
import type { PiiPolicySet } from "../pii/policy-set.js";
import type { PiiRuntime } from "../pii/runtime.js";
import type { RuntimePiiPolicy } from "../pii/runtime-policy.js";

/**
 * A child workflow's deps under the policies of the workflows above it (#1150): the PII runtime
 * of the chain (`PiiRuntime.inChain`), its observers and log masked by the chain's observability
 * set, its own children chained in turn. Every way to a child's deps — the compile of a pass, a
 * pause's notices and reply, an undo, a record — goes through its parent's `childDepsOf`, so each
 * reads the chain it runs under; a remote child is chained by the policy names its launch carries
 * (`queued-child-run.ts`).
 */

/** Finds a workflow's own deps by class: the application's, as each workflow was built. */
export type ChildDepsLookup = (workflow: Class) => GraphDeps<string> | undefined;

const keyOf = (policies: readonly RuntimePiiPolicy[]): string =>
  policies
    .map((policy) => policy.name)
    .sort()
    .join(",");

/** The log with every message masked by `mask` first (then by its own). */
const chainedLog = (log: FrameworkLog, mask: ObservabilityMask): FrameworkLog => ({
  info: (code, message, subject) => {
    log.info(code, mask.text(message), subject);
  },
  warn: (code, message, subject) => {
    log.warn(code, mask.text(message), subject);
  },
  error: (code, message, subject) => {
    log.error(code, mask.text(message), subject);
  },
});

/** Chained deps by the workflow's own deps and what they inherit: one object per chain. */
const chained = new WeakMap<GraphDeps<string>, Map<string, GraphDeps<string>>>();

/** Whether every policy of `inherited` is one `own` already has: chaining changes nothing. */
const adds = (own: PiiPolicySet, inherited: readonly RuntimePiiPolicy[]): boolean => {
  const names = new Set(own.policies.map((policy) => policy.name));
  return inherited.some((policy) => !names.has(policy.name));
};

/** `child`'s own deps under `inherited` — the observability set of the workflow that launches it. */
export function inChainOf(
  child: GraphDeps<string>,
  inherited: readonly RuntimePiiPolicy[],
  lookup: ChildDepsLookup,
): GraphDeps<string> {
  const own = child.pii;
  if (own === undefined || !adds(own.observed, inherited)) return child;
  const key = keyOf(inherited);
  const known = chained.get(child)?.get(key);
  if (known !== undefined) return known;
  const pii = own.inChain(inherited);
  const mask = pii.observability;
  const deps: GraphDeps<string> = {
    ...child,
    pii,
    ...(child.observer === undefined
      ? {}
      : { observer: child.observer.masked((event) => mask.value(event)) }),
    ...(child.log === undefined ? {} : { log: chainedLog(child.log, mask) }),
    childDepsOf: chainedChildDepsOf(lookup, pii),
  };
  const byKey = chained.get(child) ?? new Map<string, GraphDeps<string>>();
  byKey.set(key, deps);
  chained.set(child, byKey);
  return deps;
}

/** A workflow's `childDepsOf`: each child's own deps under this workflow's chain (#1150). */
export const chainedChildDepsOf =
  (lookup: ChildDepsLookup, pii: PiiRuntime | undefined): ChildDepsLookup =>
  (workflow) => {
    const child = lookup(workflow);
    if (child === undefined || pii === undefined) return child;
    return inChainOf(child, pii.observed.policies, lookup);
  };

/** A workflow's parts with its children's deps under its chain (#1150): what its tree reads. */
export const withChainedChildren = <
  TParts extends { readonly childDepsOf?: ChildDepsLookup | undefined },
>(
  parts: TParts,
  pii: PiiRuntime,
): TParts =>
  parts.childDepsOf === undefined
    ? parts
    : { ...parts, childDepsOf: chainedChildDepsOf(parts.childDepsOf, pii) };
