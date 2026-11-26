import type { AGBossErrorOptions, ErrorDetails } from "../errors.js";
import type { VariantCommon, VariantSpec } from "./family.js";

/** Plain JSON facts only (a text, a number, a boolean, a list of them): what a record keeps. */
function detailsOf(facts: Readonly<Record<string, unknown>>): ErrorDetails {
  // a `Date` fact is an ISO 8601 text on the record (G3: dates in memory, texts on the wire)
  const asText = (value: unknown): unknown =>
    value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : value;
  const isPlain = (value: unknown): boolean =>
    value === null || ["string", "number", "boolean"].includes(typeof value);
  return Object.fromEntries(
    Object.entries(facts)
      .map(([key, value]) => [key, asText(value)] as const)
      .filter(([, value]) => isPlain(value) || (Array.isArray(value) && value.every(isPlain))),
  );
}

const isDetails = (value: unknown): value is ErrorDetails =>
  typeof value === "object" && value !== null;

/** A variant's default sentence: a fixed text, or one made of the facts it was given. */
function defaultMessageOf(spec: VariantSpec[0], facts: object): string {
  return typeof spec === "string" ? spec : (spec as (facts: object) => string)(facts);
}

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
  const reserved = RESERVED_FACTS.find((key) => key in given);
  if (reserved !== undefined)
    throw new TypeError(`"${reserved}" is not a fact of an error: the instance owns it`);
  const kept = keep === undefined ? {} : (keep as (facts: object) => object)(given);
  // a fact given as `undefined` stays a (key-bearing) fact unless the variant derives its value
  const defined = Object.fromEntries(
    Object.entries(given).filter(([key, value]) => value !== undefined || !(key in kept)),
  );
  return force === true ? { ...given, ...kept } : { ...kept, ...defined };
}

/** What an instance owns itself: a fact of these names would clobber it (or throw, `spend` being a getter). */
const RESERVED_FACTS: readonly string[] = ["kind", "code", "name", "spend"];

/** What a variant's constructor hands its base: the sentence, the base's options and the facts it keeps. */
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
