import type { Class } from "../components/injection.js";
import { isGuardrailVerdict, type GuardrailHandler } from "../components/guardrail-handler.js";
import type { GuardrailOutcome } from "../core/observability.js";
import { GuardFailedError } from "../graph/errors.js";
import type { LoadedCodeGuardrail } from "./assembly.js";
import { textOfGuarded, type GuardedText } from "./guarded-text.js";
import type { GuardrailDecision } from "./runtime.js";

/**
 * A code guardrail at run time (#383): its class's `check(text)` (or `checkContent` with files) on the text the guarded model reads
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

/**
 * What the class is asked: with files, `checkContent` when it has one (the files as they are), else `check`
 * on the text and the text of the files; without files, `check(text)` as ever.
 */
function verdictOf(instance: GuardrailHandler, checked: GuardedText): unknown {
  const files = checked.files ?? [];
  if (files.length === 0) return instance.check(checked.text);
  if (instance.checkContent !== undefined)
    return instance.checkContent({ text: checked.text, files: files.map((file) => file.content) });
  return instance.check(textOfGuarded(checked));
}

/** A code guardrail's decision on one text: the instance's verdict as an outcome. */
export function codeGuardrailDecision(
  guardrail: LoadedCodeGuardrail,
  resolve: (cls: Class) => unknown,
): GuardrailDecision {
  return async (checked, spent) => {
    const instance = resolve(guardrail.type);
    if (!isHandler(instance))
      throw new GuardFailedError({
        guard: guardrail.name,
        usage: [...spent],
        reason: "its class has no check(text)",
      });
    let verdict: unknown;
    try {
      verdict = await verdictOf(instance, checked);
    } catch (error: unknown) {
      throw new GuardFailedError({
        guard: guardrail.name,
        usage: [...spent],
        reason: messageOf(error),
        cause: error,
      });
    }
    if (!isGuardrailVerdict(verdict))
      throw new GuardFailedError({
        guard: guardrail.name,
        usage: [...spent],
        reason:
          "check(text) returned no GuardrailVerdict — return GuardrailVerdict.passed() or .blocked()",
      });
    return verdict.isBlocked ? BLOCKED : PASSED;
  };
}
