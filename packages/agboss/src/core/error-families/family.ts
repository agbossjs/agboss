// the report from its own module, not `finops/usage`: `units` reaches this file for `ConfigError.Unit`
import type { CostReport } from "../../finops/cost-report.js";
import type { UsageRecord } from "../../finops/usage.js";
import { AGBossError, type AGBossErrorOptions, type ErrorDetails } from "../errors.js";
import { spendReportOf } from "./spend-report.js";
import { argsOf } from "./family-args.js";

/**
 * Error families (#1325): the errors of one area as one `type` (a union discriminated by `kind`), one
 * constructor (`err instanceof LimitError`) and one variant constructor each (`LimitError.Budget`,
 * `err instanceof LimitError.Budget`, `.onError(LimitError.Budget, …)`). A family is declared with
 * `defineFamily`; its variants' facts are the interfaces of the family's namespace.
 */

/** A variant of a family: an `AGBossError` of one `kind`; the variant's own facts extend it. */
export interface ErrorVariant<
  TKind extends string,
  TCode extends string = string,
> extends AGBossError {
  /** Which variant of its family this is: what `switch (error.kind)` narrows on. */
  readonly kind: TKind;
  /** The variant's code, a literal: what `switch (error.code)` narrows on. */
  readonly code: TCode;
}

/**
 * A variant of a family whose errors carry the spend of the step that made them (#1325: the step,
 * limit, guardrail and PII families): `usage` is what the ledger still has to see, `spend` is its
 * report (the old `StepError`, folded into each family).
 */
export interface PaidErrorVariant<
  TKind extends string,
  TCode extends string = string,
> extends ErrorVariant<TKind, TCode> {
  readonly usage: readonly UsageRecord[];
  readonly spend: CostReport;
}

/** What a variant constructor takes besides its own facts. */
export interface VariantCommon extends Pick<
  AGBossErrorOptions,
  "location" | "secondarySpans" | "notes" | "help" | "suggestionPatch"
> {
  /** A sentence of your own; the variant's default says what happened, never a stored or model text. */
  readonly message?: string;
  readonly cause?: unknown;
  /** Plain JSON facts the error's record keeps besides its own fields. */
  readonly details?: ErrorDetails;
}

/** The facts of a variant `TVariant`: its own fields, the way its constructor takes them. */
export type VariantFacts<TVariant extends AGBossError> = Omit<
  TVariant,
  keyof AGBossError | "kind" | "spend" | "usage"
>;

/** `usage` is optional in what a paid variant takes: none by default. */
export type PaidFacts<TVariant extends AGBossError> = TVariant extends {
  readonly usage: readonly UsageRecord[];
}
  ? { readonly usage?: readonly UsageRecord[] }
  : unknown;

/** What `new Family.Variant(…)` takes: the variant's facts, `message`, `cause`. */
export type VariantOptions<TVariant extends AGBossError> = VariantFacts<TVariant> &
  PaidFacts<TVariant> &
  VariantCommon;

/**
 * What `new Family.Variant(…)` takes when the variant fills some facts in itself (`TDefaulted`: the
 * step's coordinates from its frame, a limit's `actual` from its `limit`): those are optional.
 */
export type DefaultedOptions<TVariant extends AGBossError, TDefaulted extends PropertyKey> = Omit<
  VariantOptions<TVariant>,
  TDefaulted
> &
  Partial<Pick<VariantOptions<TVariant>, Extract<TDefaulted, keyof VariantOptions<TVariant>>>>;

/** The constructor of a variant: no argument at all when it has no required fact; its static `code`. */
export type VariantConstructor<
  TVariant extends AGBossError,
  TDefaulted extends PropertyKey = never,
> = (Partial<DefaultedOptions<TVariant, TDefaulted>> extends DefaultedOptions<TVariant, TDefaulted>
  ? new (options?: DefaultedOptions<TVariant, TDefaulted>) => TVariant
  : new (options: DefaultedOptions<TVariant, TDefaulted>) => TVariant) & {
  readonly code: string;
};

/** The variant constructors of a family, by variant name: `{ Budget: …, Deadline: … }`. */
export type VariantConstructors<
  TVariants extends Readonly<Record<string, AGBossError>>,
  TDefaulted extends Readonly<Partial<Record<keyof TVariants, PropertyKey>>> = Readonly<
    Partial<Record<keyof TVariants, never>>
  >,
> = {
  readonly [TName in keyof TVariants]: VariantConstructor<
    TVariants[TName],
    TName extends keyof TDefaulted ? Exclude<TDefaulted[TName], undefined> : never
  >;
};

/**
 * What a family's value is: an abstract constructor of the family's union (so `instanceof Family`
 * narrows to it, and `.onError(Family, …)` takes any variant) that carries a constructor per variant
 * and the family's `code` — the prefix of every variant's code.
 */
export type FamilyConstructor<
  TFamily extends AGBossError,
  TVariants extends Readonly<Record<string, AGBossError>>,
  TDefaulted extends Readonly<Partial<Record<keyof TVariants, PropertyKey>>> = Readonly<
    Partial<Record<keyof TVariants, never>>
  >,
> = (abstract new (...args: never[]) => TFamily) &
  VariantConstructors<TVariants, TDefaulted> & { readonly code: string };

/**
 * How one variant is declared at run time: its default sentence — a text, or a function of the
 * variant's facts (never made of a stored or model text) — and, when it is not
 * `<family code>.<kind>`, its code.
 */
export type VariantSpec = readonly [
  message: string | ((facts: never) => string),
  code?: string,
  more?: VariantMore,
];

/** What a variant does besides its sentence and its code. */
export interface VariantMore {
  /** Makes the facts the variant keeps of the ones it was given (the step's coordinates from its frame): a remote text never gets past it. */
  readonly keep?: (facts: never) => object;
  /** Facts the variant keeps that stay off its record's `details` (an id that is a credential). */
  readonly hidden?: readonly string[];
  /** Plain JSON the record's `details` keep besides the plain facts (the step's component record). */
  readonly extra?: (facts: never) => ErrorDetails;
  /** The `cause` of an error made with none: what the facts say failed. */
  readonly cause?: (facts: never) => unknown;
  /** The variant's `keep` replaces what it is given (it cleans a remote text) instead of filling in what is not. */
  readonly force?: boolean;
  /** The facts its sentence is made of: without one of them the variant says `plain`. */
  readonly needs?: readonly string[];
  /** The sentence of a variant made with none of the facts it needs. */
  readonly plain?: string;
}

/** The names of a family constructor's variants. */
export type VariantNamesOf<TConstructor> = Exclude<keyof TConstructor, "prototype" | "code">;

/**
 * A family's declaration: its name, its code, the `kind` enum (its keys are the variants' names) and
 * a spec for each variant — the compiler asks for exactly the variants the constructor type has.
 */
export interface FamilySpec<TConstructor> {
  /** `LimitError`. */
  readonly name: string;
  /** `limit`. */
  readonly code: string;
  /** The family's `kind` enum: each variant's name → its `kind`. */
  readonly kinds: Readonly<Record<VariantNamesOf<TConstructor> & string, string>>;
  readonly variants: Readonly<Record<VariantNamesOf<TConstructor>, VariantSpec>>;
  /** The family's errors carry `usage` and `spend` (the step, limit, guardrail and PII families). */
  readonly paid?: true;
}

/** A name that never collides: the variant's, qualified by its family's (`A2AError.Unavailable`). */
function named<T extends object>(constructor: T, name: string): T {
  Object.defineProperty(constructor, "name", { value: name });
  return constructor;
}

/** The class every variant of a family extends: `instanceof Family` holds for each. */
function familyBaseOf(family: FamilySpec<object>): typeof AGBossError {
  const Base = class extends AGBossError {
    static override readonly code: string = family.code;
  };
  if (family.paid === true) {
    // the spend report of the usage the error carries: made on the first read, from the same usage
    Object.defineProperty(Base.prototype, "spend", {
      get(this: { readonly usage: readonly UsageRecord[] }): CostReport {
        return spendReportOf(this.usage);
      },
    });
  }
  return named(Base, family.name);
}

const families = new WeakSet<object>();

/** Whether `value` is the constructor of an error family (`LimitError`), not an error class of its own. */
export const isErrorFamily = (value: unknown): boolean => families.has(Object(value) as object);

/** A class of a family: constructible with what its own constructor takes. */
type ErrorClass = (abstract new (...args: never[]) => AGBossError) & { readonly code: string };

/** One variant's class, extending its family's base. */
function variantOf(
  Base: typeof AGBossError,
  family: FamilySpec<object>,
  variant: string,
): ErrorClass {
  const kind: unknown = Reflect.get(family.kinds, variant);
  const spec: unknown = Reflect.get(family.variants, variant);
  if (typeof kind !== "string" || !isVariantSpec(spec))
    throw new TypeError(`${family.name}.${variant} is not declared`);
  const kindName: string = kind;
  const parsed: VariantSpec = spec;
  const code = parsed[1] ?? `${family.code}.${kind}`;
  const Variant = class extends Base {
    static override readonly code: string = code;
    readonly kind: string = kindName;
    readonly usage?: readonly UsageRecord[];

    constructor(options: VariantCommon & Readonly<Record<string, unknown>> = {}) {
      const { message, base, facts } = argsOf(parsed, options);
      super(message, base);
      Object.assign(this, facts);
      if (family.paid === true) this.usage ??= [];
    }
  };
  return named(Variant, `${family.name}.${variant}`);
}

function isVariantSpec(value: unknown): value is VariantSpec {
  if (!Array.isArray(value)) return false;
  const sentence: unknown = value[0];
  if (typeof sentence === "string") return true;
  return typeof sentence === "function";
}

/**
 * The value of a family: its base class carrying a class per variant, each named `Family.Variant`.
 * `TConstructor` is the family's declared type — the one place the types and the classes meet.
 */
export function defineFamily<TConstructor extends object>(
  family: FamilySpec<TConstructor>,
): TConstructor {
  const Base = familyBaseOf(family);
  const names = Object.keys(family.variants);
  const variants = Object.fromEntries(names.map((name) => [name, variantOf(Base, family, name)]));
  const constructor: object = Object.assign(Base, variants);
  families.add(constructor);
  return constructor as TConstructor;
}

/** A variant's spec that says `plain` when it is made with none of the facts its sentence needs. */
export const plainly = (
  spec: VariantSpec,
  needs: readonly string[],
  plain: string,
): VariantSpec => [spec[0], spec[1], { ...spec[2], needs, plain }];
