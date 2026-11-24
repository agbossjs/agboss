import type { UsageRecord } from "../finops/usage.js";
import { PiiAction, type AnyPiiAction, type BlockAction } from "./actions.js";
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
 * and, with `model`, its model detection. `find` is what the model boundary uses (the
 * model too); the observability mask never calls a model (`DetectionMode.WithoutModel`).
 */

/** Whether a search may call the policy's model. */
export enum DetectionMode {
  /** Formats, the project's detector and the model (the model boundary). */
  WithModel = "with-model",
  /** Formats and the project's detector only (logs, traces, events). */
  WithoutModel = "without-model",
}

/**
 * A value the model found: its range and kind. No kind — the model named one of no id — is masked
 * all the same (`<pii>`), and so is a kind the policy names no rule for: what the policy cannot
 * place is never let through (#1301).
 */
export interface ModelFoundRange extends PiiMatch {
  readonly kind?: PiiKind | undefined;
}

/** The label of a value the model found under a kind of no id: `<pii>`. */
export const UNKNOWN_KIND_LABEL = "pii";

/** What a model search gave: the ranges and what the call cost. */
export interface ModelDetected {
  readonly ranges: readonly ModelFoundRange[];
  readonly usage: readonly UsageRecord[];
}

/** The model search of a policy (`model`): the kinds to look for in a text. */
export type ModelDetection = (text: string, kinds: readonly PiiKind[]) => Promise<ModelDetected>;

/** What a search found, and what its model calls cost. */
export interface PolicySearch {
  readonly findings: readonly PiiFinding[];
  readonly usage: readonly UsageRecord[];
}

export interface RuntimePiiPolicy {
  readonly name: string;
  /** What `@PiiPolicy` declared (its rules or its action): what the fingerprint hashes (#120). */
  readonly meta: PiiPolicyMeta;
  /** Its action per kind (a declarative policy); empty for a project's detector. */
  readonly actions: ReadonlyMap<PiiKind, AnyPiiAction>;
  find(text: string, mode: DetectionMode): Promise<PolicySearch>;
  /** What the formats (and a project's detector that answers at once) find — for the log. */
  findNow(text: string): readonly PiiFinding[];
  /** The text a block rule sends: its own, or the class's `refusal(kind)`. */
  refusalOf(kind: PiiKind | undefined, action: BlockAction): Promise<string>;
}

/** What a runtime policy is built from. */
export interface RuntimePolicyParts {
  readonly meta: PiiPolicyMeta;
  readonly instance: unknown;
  /** The resolved `secret` (or the application's key for a policy without its own). */
  readonly key: string;
  /** The resolved `previousSecret` (or the application's previous key): none when unset. */
  readonly previousKey?: string | undefined;
  readonly detection?: ModelDetection;
}

/** A project detector's label: its name without `-pii-policy`. */
export const labelOfPolicy = (name: string): string => name.replace(/-pii-policy$/, "");

const hasRefusal = (instance: unknown): instance is PiiRefusal =>
  typeof instance === "object" &&
  instance !== null &&
  "refusal" in instance &&
  typeof instance.refusal === "function";

/** What a value the model found and no rule names becomes: masked, one-way. */
const UNKNOWN_KIND_ACTION = PiiAction.mask();

const previousOf = (previousKey: string | undefined): { readonly previousKey?: string } =>
  previousKey === undefined ? {} : { previousKey };

const NO_SEARCH: PolicySearch = { findings: [], usage: [] };

function customPolicy(parts: RuntimePolicyParts, action: AnyPiiAction): RuntimePiiPolicy {
  const { meta, key, previousKey } = parts;
  const handler = parts.instance as PiiPolicyHandler;
  const label = labelOfPolicy(meta.name);
  const findingOf = (match: PiiMatch): PiiFinding => ({
    ...match,
    label,
    action,
    policy: meta.name,
    key,
    ...previousOf(previousKey),
    rank: -1,
  });
  return {
    name: meta.name,
    meta,
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

/** What a declarative finding is made of: the policy, its actions and its keys. */
interface DeclarativeFinding {
  readonly meta: DeclarativePiiPolicyMeta;
  readonly actions: ReadonlyMap<PiiKind, AnyPiiAction>;
  readonly key: string;
  readonly previousKey: string | undefined;
}

/** One range as a finding: a kind of no id, or one the policy names no rule for, is masked all the same. */
function declarativeFindingOf(
  range: ModelFoundRange & { readonly rank?: number },
  { meta, actions, key, previousKey }: DeclarativeFinding,
): PiiFinding {
  const { start, end, kind } = range;
  const rank = range.rank ?? 99;
  const keys = { policy: meta.name, key, ...previousOf(previousKey), rank };
  if (kind === undefined)
    return { start, end, label: UNKNOWN_KIND_LABEL, action: UNKNOWN_KIND_ACTION, ...keys };
  // a kind the policy names none of (the model's answer beyond what it was asked): masked
  return {
    start,
    end,
    kind,
    label: kind.id,
    action: actions.get(kind) ?? UNKNOWN_KIND_ACTION,
    ...keys,
  };
}

function declarativePolicy(
  parts: RuntimePolicyParts,
  meta: DeclarativePiiPolicyMeta,
): RuntimePiiPolicy {
  const { key, previousKey, instance } = parts;
  const { actions } = kindActionsOf(meta.rules);
  const formatKinds = new Set([...actions.keys()].filter((kind) => !MODEL_ONLY_KINDS.has(kind)));
  const modelKinds = [...actions.keys()].filter((kind) => MODEL_ONLY_KINDS.has(kind));
  const findingOf = (range: ModelFoundRange & { readonly rank?: number }): PiiFinding[] => [
    declarativeFindingOf(range, { meta, actions, key, previousKey }),
  ];
  const findNow = (text: string): PiiFinding[] =>
    findFormatRanges(text, formatKinds).flatMap(findingOf);
  return {
    name: meta.name,
    meta,
    actions,
    findNow,
    find: async (text, mode) => {
      const model = mode === DetectionMode.WithModel ? parts.detection : undefined;
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
