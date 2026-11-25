import type { AGBossErrorOptions, ErrorDetails } from "../errors.js";
import type { VariantCommon, VariantSpec } from "./family.js";

/** Plain JSON facts only (a text, a number, a boolean, a list of them): what a record keeps. */
function detailsOf(facts: Readonly<Record<string, unknown>>): ErrorDetails {
  const isPlain = (value: unknown): boolean =>
    value === null || ["string", "number", "boolean"].includes(typeof value);
  return Object.fromEntries(
    Object.entries(facts).filter(
      ([, value]) => isPlain(value) || (Array.isArray(value) && value.every(isPlain)),
    ),
  );
}

const isDetails = (value: unknown): value is ErrorDetails =>
  typeof value === "object" && value !== null;

/** A variant's default sentence: a fixed text, or one made of the facts it was given. */
function defaultMessageOf(spec: VariantSpec[0], facts: object): string {
  return typeof spec === "string" ? spec : (spec as (facts: object) => string)(facts);
}

/** What a variant's constructor hands its base: the sentence, the base's options and the facts it keeps. */
/** The sentence of a variant made with none of its own: `plain` without the facts it needs, else made of them. */
function sentenceOf(
  [defaultMessage, , more = {}]: VariantSpec,
  facts: Readonly<Record<string, unknown>>,
  cause: unknown,
): string {
  const { needs = [], plain } = more;
  return needs.some((key) => facts[key] === undefined || facts[key] === "") && plain !== undefined
    ? plain
    : defaultMessageOf(defaultMessage, { ...facts, cause });
}

/** The facts a variant keeps: what it was given, filled in (or, when it `force`s, cleaned) by its `keep`. */
function factsOf(
  spec: VariantSpec,
  given: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { keep, force } = spec[2] ?? {};
  const kept = keep === undefined ? {} : (keep as (facts: object) => object)(given);
  const defined = Object.fromEntries(
    Object.entries(given).filter(([, value]) => value !== undefined),
  );
  // what was given wins over what the variant derives, unless the variant must clean what it is given
  return force === true ? { ...given, ...kept } : { ...kept, ...defined };
}

export function argsOf(
  spec: VariantSpec,
  options: VariantCommon & Readonly<Record<string, unknown>>,
): {
  readonly message: string;
  readonly base: AGBossErrorOptions;
  readonly facts: Readonly<Record<string, unknown>>;
} {
  const { hidden = [], extra, cause: causeOf } = spec[2] ?? {};
  const {
    message,
    cause,
    details,
    location,
    secondarySpans,
    notes,
    help,
    suggestionPatch,
    ...given
  } = options;
  const facts = factsOf(spec, given);
  const why: unknown =
    cause !== undefined
      ? cause
      : causeOf === undefined
        ? undefined
        : (causeOf as (facts: object) => unknown)(facts);
  const shown = Object.fromEntries(
    Object.entries(facts).filter(([key]) => key !== "usage" && !hidden.includes(key)),
  );
  return {
    message: typeof message === "string" ? message : sentenceOf(spec, facts, why),
    base: {
      cause: why,
      location,
      secondarySpans,
      notes,
      help,
      suggestionPatch,
      details: {
        ...detailsOf(shown),
        ...(extra === undefined ? {} : (extra as (facts: object) => ErrorDetails)(facts)),
        ...(isDetails(details) ? details : {}),
      },
    },
    facts,
  };
}
