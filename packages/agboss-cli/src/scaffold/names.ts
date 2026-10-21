import { ScaffoldUsageError } from "./errors.js";

/** One name in every spelling the generated code needs. */
export interface Names {
  /** file and folder names, the qualifier of a component's `name`: `search-orders` */
  readonly kebab: string;
  /** identifiers in prose and snake-case keys: `search_orders` */
  readonly snake: string;
  /** class names: `SearchOrders` */
  readonly pascal: string;
  /** prose: `Search orders` */
  readonly title: string;
}

/** A component's full name (`billing-agent`) and the qualifier it is built from (`billing`). */
export interface FullName extends Names {
  /** the full, kind-suffixed name, as in `name`, traces and records: `billing-agent` */
  readonly full: string;
}

const words = (raw: string): string[] =>
  raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** `"Search Orders"`, `searchOrders`, `search-orders` → one `Names`; letters first, letters and digits only. */
export function namesOf(raw: string): Names {
  const parts = words(raw);
  const [first] = parts;
  if (first === undefined || !/^[a-z]/.test(first)) {
    throw new ScaffoldUsageError(
      `"${raw}" is not a valid name: start with a letter, use letters and digits`,
    );
  }
  return {
    kebab: parts.join("-"),
    snake: parts.join("_"),
    pascal: parts.map(capital).join(""),
    title: capital(parts.join(" ")),
  };
}

/** A field named after its type (#280): `ShortlistServer` → `shortlistServer`. */
export const camelOf = (names: Names): string =>
  names.pascal.charAt(0).toLowerCase() + names.pascal.slice(1);

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The full name to suggest for a typed one: kebab-case, ending with the kind. */
const suggestion = (raw: string, kind: string): string => {
  const kebab = words(raw).join("-");
  return kebab.endsWith(`-${kind}`) ? kebab : `${kebab}-${kind}`;
};

/**
 * A component's full name as the CLI takes it (#268 AC8): kebab-case ending with its kind —
 * `billing-agent`, `onboarding-workflow`, `search-orders-tool`. The CLI never adds the suffix: a
 * name without it is rejected with the full name as a hint, and nothing is written.
 */
export function fullNameOf(raw: string, kind: string): FullName {
  const suffix = `-${kind}`;
  const name = raw.trim();
  if (!KEBAB_CASE.test(name) || !name.endsWith(suffix) || name.length === suffix.length) {
    throw new ScaffoldUsageError(
      `"${raw}" is not a full ${kind} name: kebab-case, ending with ${suffix}. Did you mean "${suggestion(raw, kind)}"?`,
    );
  }
  return { ...namesOf(name.slice(0, -suffix.length)), full: name };
}
