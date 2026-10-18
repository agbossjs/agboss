import { isVariant, variantClassOf, type ProducedValue } from "../flow/dto-wrappers.js";

/**
 * The run-time side of `PartialValues<InputOf<X>>` (#262): whether a node's input — its fields as
 * the node read them, `Produced` records — matches a partial over values. `when(…)`,
 * `toHaveBeenCalledWith(…)` and the failure messages share it.
 */

/** A node's input as it read it: field → `Produced` record(s), or a plain value. */
export type RecordedInput = Readonly<Record<string, unknown>>;

/** Vitest's `expect.any(…)`, `expect.objectContaining(…)`: they match by themselves. */
interface AsymmetricMatcher {
  asymmetricMatch(actual: unknown): boolean;
}

const isAsymmetric = (value: unknown): value is AsymmetricMatcher =>
  typeof value === "object" &&
  value !== null &&
  "asymmetricMatch" in value &&
  typeof value.asymmetricMatch === "function";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A value read from the path: `{ producer, value }` and nothing else. */
const isProduced = (value: unknown): value is ProducedValue<unknown, unknown> =>
  isRecord(value) && Object.keys(value).length === 2 && "producer" in value && "value" in value;

/** A `historyOf` field: `{ current, previous }`. */
const isHistory = (
  value: unknown,
): value is { readonly current: unknown; readonly previous: readonly unknown[] } =>
  isRecord(value) && "current" in value && Array.isArray(value.previous);

/** A deep partial: every given key matches, lists by length and position, `undefined` = absent. */
export function matchesPartial(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (expected === undefined) return actual === undefined;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, index) => matchesPartial(actual[index], item));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(([key, item]) => matchesPartial(actual[key], item));
  }
  return Object.is(actual, expected);
}

/** One value: a `Produced` record by its value (and by its class, given as `variant(…)`). */
function matchesValue(actual: unknown, expected: unknown): boolean {
  if (!isProduced(actual)) return matchesPartial(actual, expected);
  const dto = variantClassOf(expected);
  if (dto !== undefined && !isVariant(actual, dto)) return false;
  return matchesPartial(actual.value, expected);
}

function matchesList(actual: readonly unknown[], expected: unknown): boolean {
  if (!Array.isArray(expected) || actual.length !== expected.length) return false;
  return expected.every((item, index) => matchesValue(actual[index], item));
}

function matchesField(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (expected === undefined) return actual === undefined;
  if (actual === undefined) return false;
  if (isHistory(actual) && isRecord(expected)) {
    const { current, previous } = expected;
    return (
      (current === undefined || matchesValue(actual.current, current)) &&
      (previous === undefined || matchesList(actual.previous, previous))
    );
  }
  if (Array.isArray(actual)) return matchesList(actual, expected);
  return matchesValue(actual, expected);
}

/** Whether a node's input matches a `PartialValues` matcher (only the keys it gives). */
export const matchesInput = (actual: RecordedInput, expected: RecordedInput): boolean =>
  Object.entries(expected).every(([key, item]) => matchesField(actual[key], item));

/** The values of an input, without producers — for messages. */
function valuesOf(value: unknown): unknown {
  if (isProduced(value)) return valuesOf(value.value);
  if (Array.isArray(value)) return value.map(valuesOf);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, valuesOf(item)]));
  return value;
}

/** An input as a message names it: its values as JSON. */
export const inputText = (input: RecordedInput | undefined): string =>
  input === undefined ? "(no input: not a step of a workflow)" : JSON.stringify(valuesOf(input));
