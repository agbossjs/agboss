import type { ErrorClass } from "../flow/ast.js";
import { matchesPartial } from "./input-match.js";
import type { DeepPartial } from "./script-types.js";

/**
 * `await expect(app.execute(…)).rejects.toFailWith(ErrorClass, { …fields, cause })` (#262 AC10):
 * the error or one it was caused by is an instance of the class (a subclass too) and has the
 * fields — each a deep partial, asymmetric matchers allowed; `cause` names a class further down
 * the chain. The testing API never creates the error: it comes from the real cause.
 */

/** `cause` in `toFailWith`'s fields: a class the matched error was caused by, below it in the chain. */
interface ExpectedCause {
  readonly cause?: ErrorClass;
}

/**
 * The fields `toFailWith` checks: deep partials of the error's own, `cause` as a class. Through
 * `.rejects` Vitest erases the matcher's generic to `Error`: the fields are then any fields.
 */
export type ExpectedErrorFields<TError extends Error> = Error extends TError
  ? Readonly<Record<string, unknown>> & ExpectedCause
  : {
      readonly [TKey in Exclude<keyof TError, "cause" | "stack">]?: DeepPartial<TError[TKey]>;
    } & ExpectedCause;

/** An error and every error it was caused by, outermost first. */
function chainOf(error: unknown): readonly Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    chain.push(current);
    if (chain.length > 32) break;
  }
  return chain;
}

/** Whether one error of the chain is the expected one: its class and fields, its causes. */
function isExpected(
  chain: readonly Error[],
  index: number,
  expected: ErrorClass,
  fields: Readonly<Record<string, unknown>>,
): boolean {
  const error = chain[index];
  if (!(error instanceof expected)) return false;
  return Object.entries(fields).every(([key, value]) => {
    if (key === "cause" && typeof value === "function") {
      return chain.slice(index + 1).some((below) => below instanceof (value as ErrorClass));
    }
    // a field or a getter (`code`): read through the prototype chain
    const actual: unknown = Reflect.get(error, key);
    return matchesPartial(actual, value);
  });
}

/** One error as the message names it: its class and message. */
const errorText = (error: Error): string => `${error.name}: ${error.message}`;

/** What `toFailWith` decides: whether it passed, and the chain it looked at. */
export interface ErrorMatch {
  readonly pass: boolean;
  readonly got: string;
}

export function matchError(
  received: unknown,
  expected: ErrorClass,
  fields: Readonly<Record<string, unknown>> = {},
): ErrorMatch {
  const chain = chainOf(received);
  const pass = chain.some((_, index) => isExpected(chain, index, expected, fields));
  const got =
    chain.length === 0 ? "got no error" : `got ${chain.map(errorText).join(", caused by ")}`;
  return { pass, got };
}
