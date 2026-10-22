import type { Class } from "../components/injection.js";
import { isGuardrailVerdict, type GuardrailHandler } from "../components/guardrail-handler.js";
import type { GuardrailOutcome } from "../core/observability.js";
import { GuardFailedError } from "../graph/errors.js";
import type { LoadedCodeGuardrail } from "./assembly.js";
import type { GuardrailDecision } from "./runtime.js";

/**
 * A code guardrail at run time (#383): its class's `check(text)` on the text the guarded model reads
 * (masked), in the step's frame — no model call, no spend. Its verdict is certain: blocked is
 * `probability` 1, passed 0, so its hit meets the fixed threshold `CODE_GUARDRAIL_THRESHOLD`. A
 * `check` that throws, or returns anything but a `GuardrailVerdict`, fails closed
 * (`GuardFailedError`, the error as its `cause`): nothing passes unchecked.
 */

/** The threshold a code guardrail's verdict is measured against: blocked is P(yes) = 1. */
export const CODE_GUARDRAIL_THRESHOLD = 1;

const BLOCKED: GuardrailOutcome = Object.freeze({ isBlocked: true, probability: 1 });
const PASSED: GuardrailOutcome = Object.freeze({ isBlocked: false, probability: 0 });

const isHandler = (value: unknown): value is GuardrailHandler =>
  typeof value === "object" &&
  value !== null &&
  "check" in value &&
  typeof value.check === "function";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A code guardrail's decision on one text: the instance's verdict as an outcome. */
export function codeGuardrailDecision(
  guardrail: LoadedCodeGuardrail,
  resolve: (cls: Class) => unknown,
): GuardrailDecision {
  return async ({ text }, spent) => {
    const instance = resolve(guardrail.type);
    if (!isHandler(instance))
      throw new GuardFailedError(guardrail.name, [...spent], "its class has no check(text)");
    let verdict: unknown;
    try {
      verdict = await instance.check(text);
    } catch (error: unknown) {
      throw new GuardFailedError(guardrail.name, [...spent], messageOf(error), error);
    }
    if (!isGuardrailVerdict(verdict))
      throw new GuardFailedError(
        guardrail.name,
        [...spent],
        "check(text) returned no GuardrailVerdict — return GuardrailVerdict.passed() or .blocked()",
      );
    return verdict.isBlocked ? BLOCKED : PASSED;
  };
}
