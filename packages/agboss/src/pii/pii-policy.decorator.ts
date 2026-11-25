import { recordOptionKeys } from "../components/option-keys.js";
import { PII_POLICY_KEYS } from "../components/decorator-options.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { recordComponent } from "../components/metadata.js";
import { resolvedName } from "../flow/names.js";
import type { OptionalSecretRef, SecretRef } from "../environments/env-ref.js";
import type { AnyPiiAction, MaskingPiiAction } from "./actions.js";
import type { PiiKind, PiiTarget } from "./kinds.js";

/**
 * `@PiiPolicy` (#120): which personal data its models and tools never see as is, and what happens
 * to it. Two forms, one decorator:
 * - declarative — `rules: [PiiKind.Email.tokenize(), PiiGroup.Contact.mask(), …]`; only the kinds
 *   the rules name are detected, each target named once (`[pii.duplicate-target]`), a kind rule
 *   beats a group rule, names and addresses in free text are found by its `model`;
 * - a project's own detector (S59, S61) — `{ name, action, deps }` + `implements PiiPolicyHandler`:
 *   `findMatches(text)` gives the ranges, the framework applies `action` to each.
 * Listed in `piiPolicies: [...]` of `@Application`, `@Workflow`, `@Agent` and `@Router` (lists add
 * up; `excludePiiPolicies` removes one for an agent or a router).
 */

/** What a policy lets happen to the files of an agent's model (#899 §5); a closed set. */
export enum PiiFileAction {
  /** Files reach the model masked: a transcription masked by the rules, a redacted copy (the default). */
  Mask = "mask",
  /** The original file may reach the model as it is: the task hinges on the personal data. */
  AllowOriginal = "allow-original",
  /**
   * As `Mask`, and an image under this policy's block rules goes to the redaction model to decide what it
   * holds. Without it an image is refused whole where a block rule applies: what a model says an image
   * holds is a guardrail, not a guarantee — a text in the image can talk it into silence.
   */
  RedactWithModel = "redact-with-model",
}

/**
 * One rule: a kind or a group, and what happens to its values — made by the target's verb,
 * `PiiKind.Email.mask({ keepDomain: true })`.
 */
export interface PiiRule {
  readonly target: PiiTarget;
  readonly action: AnyPiiAction;
}

/** A range of the text that is personal data: `[start, end)`. */
export interface PiiMatch {
  readonly start: number;
  readonly end: number;
}

/** A project's own detector (S61): the ranges of `text` its `action` applies to. */
export interface PiiPolicyHandler {
  readonly findMatches: (text: string) => readonly PiiMatch[] | Promise<readonly PiiMatch[]>;
}

/**
 * The text of a `block()` rule without its own: computed for the kind that matched (the
 * sender's language, a CMS), the execution through `deps: [ExecutionContext]`.
 */
export interface PiiRefusal {
  readonly refusal: (kind: PiiKind) => string | Promise<string>;
}

/**
 * A declarative policy's class: when it has `refusal`, it is `PiiRefusal`'s — checked on the
 * decorator line (#120 PR 4), whatever the class `implements`.
 */
export type PiiRefusalShape<TInstance> = TInstance extends { readonly refusal: unknown }
  ? new (...args: never[]) => PiiRefusal
  : unknown;

/** The declarative form's options. */
export interface DeclarativePiiPolicyOptions<D extends readonly Token[] = readonly Token[]> {
  /** What the policy does to the files an agent's model reads (#899 §5); `PiiFileAction.Mask` when left out. */
  readonly files?: PiiFileAction;
  /** Kebab-case; the class name in kebab-case when left out (`Contact` → `contact`). */
  readonly name?: string;
  readonly description?: string;
  readonly rules: readonly [PiiRule, ...PiiRule[]];
  /** A chat model that finds names, street addresses and the other kinds without a format. */
  readonly model?: string;
  /**
   * The `@ModelProvider` class serving `model`; left out: the workflow's, the
   * application's (#1313).
   */
  readonly modelProvider?: Class;
  /**
   * The HMAC key of its `tokenize()` rules: `secret("PII_POLICY_SECRET")`, read when the app
   * starts; absent → the application's (`@DatabaseStorage({ piiSecret })`, #1321).
   */
  readonly secret?: SecretRef;
  /**
   * The key `secret` rotates from: a value already tokenized under it keeps its token in a thread
   * that holds it, and a token it made still reveals. `secret.optional("…")` may be unset.
   */
  readonly previousSecret?: SecretRef | OptionalSecretRef;
  /** Constructor dependencies (a `PiiRefusal` class's services), in order. */
  readonly deps?: D;
  readonly action?: never;
}

/** The form of a project's own detector (`implements PiiPolicyHandler`). */
export interface CustomPiiPolicyOptions<D extends readonly Token[] = readonly Token[]> {
  /** What the policy does to the files an agent's model reads (#899 §5); `PiiFileAction.Mask` when left out. */
  readonly files?: PiiFileAction;
  /** Kebab-case; the class name in kebab-case when left out (`EmployeeId` → `employee-id`). */
  readonly name?: string;
  readonly description?: string;
  /** What happens to every range `findMatches` gives. */
  readonly action: MaskingPiiAction;
  readonly deps?: D;
  readonly rules?: never;
}

/** What `@PiiPolicy` recorded for a declarative policy. */
export type DeclarativePiiPolicyMeta = DeclarativePiiPolicyOptions & {
  readonly name: string;
  readonly deps: readonly Token[];
};

/** What `@PiiPolicy` recorded for a project's own detector. */
export type CustomPiiPolicyMeta = CustomPiiPolicyOptions & {
  readonly name: string;
  readonly deps: readonly Token[];
};

/** What `@PiiPolicy` recorded. */
export type PiiPolicyMeta = DeclarativePiiPolicyMeta | CustomPiiPolicyMeta;

/** A declarative policy: its class may implement `PiiRefusal`. */
export function PiiPolicy<const D extends readonly Token[] = []>(
  options: DeclarativePiiPolicyOptions<D>,
): <C extends new (...args: ResolvedAll<D>) => object>(
  value: C & PiiRefusalShape<InstanceType<C>>,
) => C;
/** A project's own detector: its class implements `PiiPolicyHandler`. */
export function PiiPolicy<const D extends readonly Token[] = []>(
  options: CustomPiiPolicyOptions<D>,
): <C extends new (...args: ResolvedAll<D>) => PiiPolicyHandler>(value: C) => C;
export function PiiPolicy(
  options: DeclarativePiiPolicyOptions | CustomPiiPolicyOptions,
): <C extends new (...args: never[]) => object>(value: C) => C {
  return (value) => {
    recordOptionKeys(value, "PiiPolicy", options, PII_POLICY_KEYS);
    recordComponent(value, {
      kind: "pii-policy",
      meta: { ...options, name: resolvedName(options.name, value), deps: options.deps ?? [] },
    });
    return value;
  };
}

/** Whether the policy is a project's own detector. */
export const isCustomPolicy = (meta: PiiPolicyMeta): meta is CustomPiiPolicyMeta =>
  meta.action !== undefined;

/** What a policy does to files: its own setting, `Mask` when it has none. */
export const fileActionOf = (meta: PiiPolicyMeta): PiiFileAction =>
  meta.files ?? PiiFileAction.Mask;
