import type { UsageRecord } from "../finops/usage.js";
import type { BlockWithRefusalAction, AnyPiiAction } from "./actions.js";
import { findFormatRanges } from "./detectors/find.js";
import { MODEL_ONLY_KINDS, type PiiKind } from "./kinds.js";
import type { PiiFinding } from "./masking.js";
import { kindActionsOf } from "./policy-rules.js";
import {
  isCustomPolicy,
  type DeclarativePiiPolicyMeta,
  type PiiMatch,
  type PiiPolicyHandler,
  type PiiPolicyMeta,
  type PiiRefusal,
} from "./pii-policy.decorator.js";

/**
 * A `@PiiPolicy` at run time: its instance (from the container), its rules per kind, its HMAC key
 * and, with `detectWithModel`, its model detection. `find` is what the model boundary uses (the
 * model too); the observability mask never calls a model (`DetectionMode.WithoutModel`).
 */

/** Whether a search may call the policy's model. */
export enum DetectionMode {
  /** Formats, the project's detector and the model (the model boundary). */
  WithModel = "with-model",
  /** Formats and the project's detector only (logs, traces, events). */
  WithoutModel = "without-model",
}

/** A kind the model found: its range. */
export interface ModelFoundRange extends PiiMatch {
  readonly kind: PiiKind;
}

/** What a model search gave: the ranges and what the call cost. */
export interface ModelDetected {
  readonly ranges: readonly ModelFoundRange[];
  readonly usage: readonly UsageRecord[];
}

/** The model search of a policy (`detectWithModel`): the kinds to look for in a text. */
export type ModelDetection = (text: string, kinds: readonly PiiKind[]) => Promise<ModelDetected>;

/** What a search found, and what its model calls cost. */
export interface PolicySearch {
  readonly findings: readonly PiiFinding[];
  readonly usage: readonly UsageRecord[];
}

export interface RuntimePiiPolicy {
  readonly name: string;
  /** Its action per kind (a declarative policy); empty for a project's detector. */
  readonly actions: ReadonlyMap<PiiKind, AnyPiiAction>;
  find(text: string, mode: DetectionMode): Promise<PolicySearch>;
  /** What the formats (and a project's detector that answers at once) find — for the log. */
  findNow(text: string): readonly PiiFinding[];
  /** The text a block rule sends: its own, or the class's `refusal(kind)`. */
  refusalOf(kind: PiiKind | undefined, action: BlockWithRefusalAction): Promise<string>;
}

/** What a runtime policy is built from. */
export interface RuntimePolicyParts {
  readonly meta: PiiPolicyMeta;
  readonly instance: unknown;
  /** The resolved `pseudonymKey` (or the instance's key for a project's detector). */
  readonly key: string;
  readonly detectWithModel?: ModelDetection;
}

/** A project detector's label: its name without `-pii-policy`. */
export const labelOfPolicy = (name: string): string => name.replace(/-pii-policy$/, "");

const hasRefusal = (instance: unknown): instance is PiiRefusal =>
  typeof instance === "object" &&
  instance !== null &&
  "refusal" in instance &&
  typeof instance.refusal === "function";

const NO_SEARCH: PolicySearch = { findings: [], usage: [] };

function customPolicy(parts: RuntimePolicyParts, action: AnyPiiAction): RuntimePiiPolicy {
  const { meta, key } = parts;
  const handler = parts.instance as PiiPolicyHandler;
  const label = labelOfPolicy(meta.name);
  const findingOf = (match: PiiMatch): PiiFinding => ({
    ...match,
    label,
    action,
    policy: meta.name,
    key,
    rank: -1,
  });
  return {
    name: meta.name,
    actions: new Map(),
    find: async (text) => ({
      findings: (await handler.findMatches(text)).map(findingOf),
      usage: [],
    }),
    findNow: (text) => {
      const found = handler.findMatches(text);
      return Array.isArray(found) ? found.map(findingOf) : [];
    },
    refusalOf: () => Promise.resolve(""),
  };
}

function declarativePolicy(
  parts: RuntimePolicyParts,
  meta: DeclarativePiiPolicyMeta,
): RuntimePiiPolicy {
  const { key, instance } = parts;
  const { actions } = kindActionsOf(meta.rules);
  const formatKinds = new Set([...actions.keys()].filter((kind) => !MODEL_ONLY_KINDS.has(kind)));
  const modelKinds = [...actions.keys()].filter((kind) => MODEL_ONLY_KINDS.has(kind));
  const findingOf = (range: ModelFoundRange & { readonly rank?: number }): PiiFinding[] => {
    const action = actions.get(range.kind);
    if (action === undefined) return [];
    const { start, end, kind } = range;
    return [
      { start, end, kind, label: kind, action, policy: meta.name, key, rank: range.rank ?? 99 },
    ];
  };
  const findNow = (text: string): PiiFinding[] =>
    findFormatRanges(text, formatKinds).flatMap(findingOf);
  return {
    name: meta.name,
    actions,
    findNow,
    find: async (text, mode) => {
      const model = mode === DetectionMode.WithModel ? parts.detectWithModel : undefined;
      if (model === undefined || modelKinds.length === 0 || text.trim() === "")
        return { ...NO_SEARCH, findings: findNow(text) };
      const detected = await model(text, modelKinds);
      return {
        findings: [...findNow(text), ...detected.ranges.flatMap(findingOf)],
        usage: detected.usage,
      };
    },
    refusalOf: async (kind, action) => {
      if (action.refusal !== undefined) return action.refusal;
      return hasRefusal(instance) && kind !== undefined ? instance.refusal(kind) : "";
    },
  };
}

/** The runtime form of one policy. */
export const runtimePolicyOf = (parts: RuntimePolicyParts): RuntimePiiPolicy =>
  isCustomPolicy(parts.meta)
    ? customPolicy(parts, parts.meta.action)
    : declarativePolicy(parts, parts.meta);
