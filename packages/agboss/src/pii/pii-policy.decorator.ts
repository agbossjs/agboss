import type { ResolvedAll, Token } from "../components/injection.js";
import { recordComponent } from "../components/metadata.js";
import type { Secret } from "../environments/secret.js";
import type { AnyPiiAction, MaskingPiiAction } from "./actions.js";
import type { PiiKind, PiiTarget } from "./kinds.js";

/**
 * `@PiiPolicy` (#120): which personal data its models and tools never see as is, and what happens
 * to it. Two forms, one decorator:
 * - declarative — `rules: [pii(PiiKind.Email, PiiAction.replaceWithToken()), …]`; only the kinds
 *   the rules name are detected, a kind rule beats a group rule, names and addresses in free text
 *   are found by `detectWithModel`;
 * - a project's own detector (S59, S61) — `{ name, action, deps }` + `implements PiiPolicyHandler`:
 *   `findMatches(text)` gives the ranges, the framework applies `action` to each.
 * Listed in `piiPolicies: [...]` of `@Application`, `@Workflow`, `@Agent` and `@Router` (lists add
 * up; `excludePiiPolicies` removes one for an agent or a router).
 */

/** One rule: a kind or a group, and what happens to its values. */
export interface PiiRule {
  readonly target: PiiTarget;
  readonly action: AnyPiiAction;
}

/** `pii(PiiKind.Email, PiiAction.replacePart({ keepDomain: true }))`. */
export const pii = (target: PiiTarget, action: AnyPiiAction): PiiRule => ({ target, action });

/** A range of the text that is personal data: `[start, end)`. */
export interface PiiMatch {
  readonly start: number;
  readonly end: number;
}

/** A project's own detector (S61): the ranges of `text` its `action` applies to. */
export interface PiiPolicyHandler {
  findMatches(text: string): readonly PiiMatch[] | Promise<readonly PiiMatch[]>;
}

/**
 * The text of a `blockWithRefusal()` rule without its own: computed for the kind that matched (the
 * sender's language, a CMS), the execution through `deps: [ExecutionContext]`.
 */
export interface PiiRefusal {
  refusal(kind: PiiKind): string | Promise<string>;
}

/** The declarative form's options. */
export interface DeclarativePiiPolicyOptions<D extends readonly Token[] = readonly Token[]> {
  /** Ends with `-pii-policy` (`contact-pii-policy`). */
  readonly name: string;
  readonly description: string;
  readonly rules: readonly [PiiRule, ...PiiRule[]];
  /** A chat model that finds names, street addresses and the other kinds without a format. */
  readonly detectWithModel?: string;
  /**
   * The HMAC key of its `replaceWithToken()` rules: `secret("PII_PSEUDONYM_KEY")`, read when the app
   * starts; absent → the application's (`@Application({ pseudonymKey })`).
   */
  readonly pseudonymKey?: Secret;
  /** Constructor dependencies (a `PiiRefusal` class's services), in order. */
  readonly deps?: D;
  readonly action?: never;
}

/** The form of a project's own detector (`implements PiiPolicyHandler`). */
export interface CustomPiiPolicyOptions<D extends readonly Token[] = readonly Token[]> {
  /** Ends with `-pii-policy` (`employee-id-pii-policy`). */
  readonly name: string;
  /** What happens to every range `findMatches` gives. */
  readonly action: MaskingPiiAction;
  readonly deps?: D;
  readonly rules?: never;
}

/** What `@PiiPolicy` recorded for a declarative policy. */
export type DeclarativePiiPolicyMeta = DeclarativePiiPolicyOptions & {
  readonly deps: readonly Token[];
};

/** What `@PiiPolicy` recorded for a project's own detector. */
export type CustomPiiPolicyMeta = CustomPiiPolicyOptions & { readonly deps: readonly Token[] };

/** What `@PiiPolicy` recorded. */
export type PiiPolicyMeta = DeclarativePiiPolicyMeta | CustomPiiPolicyMeta;

/** A declarative policy: its class may implement `PiiRefusal`. */
export function PiiPolicy<const D extends readonly Token[] = []>(
  options: DeclarativePiiPolicyOptions<D>,
): <C extends new (...args: ResolvedAll<D>) => object>(value: C) => C;
/** A project's own detector: its class implements `PiiPolicyHandler`. */
export function PiiPolicy<const D extends readonly Token[] = []>(
  options: CustomPiiPolicyOptions<D>,
): <C extends new (...args: ResolvedAll<D>) => PiiPolicyHandler>(value: C) => C;
export function PiiPolicy(
  options: DeclarativePiiPolicyOptions | CustomPiiPolicyOptions,
): <C extends new (...args: never[]) => object>(value: C) => C {
  return (value) => {
    recordComponent(value, {
      kind: "pii-policy",
      meta: { ...options, deps: options.deps ?? [] },
    });
    return value;
  };
}

/** Whether the policy is a project's own detector. */
export const isCustomPolicy = (meta: PiiPolicyMeta): meta is CustomPiiPolicyMeta =>
  meta.action !== undefined;
