import type { Class } from "../components/injection.js";
import {
  isGuardrailVerdict,
  type GuardrailContent,
  type GuardrailHandler,
} from "../components/guardrail-handler.js";
import type { GuardrailDecided } from "./runtime.js";
import { GuardFailedError } from "../graph/errors.js";
import type { LoadedCodeGuardrail } from "./assembly.js";
import { textOfGuarded, type GuardedText } from "./guarded-text.js";
import type { GuardrailDecision } from "./runtime.js";

/**
 * A code guardrail at run time (#383): its class's `check(content)` on what the guarded model reads
 * (masked), in the step's frame — no model call, no spend. Its verdict is certain: blocked is
 * `probability` 1, passed 0, so its hit meets the fixed threshold `CODE_GUARDRAIL_THRESHOLD`. A
 * `check` that throws, or returns anything but a `GuardrailVerdict`, fails closed
 * (`GuardFailedError`, the error as its `cause`): nothing passes unchecked.
 */

/** The threshold a code guardrail's verdict is measured against: blocked is P(yes) = 1. */
export const CODE_GUARDRAIL_THRESHOLD = 1;

const BLOCKED: GuardrailDecided = Object.freeze({ isBlocked: true, probability: 1 });
const PASSED: GuardrailDecided = Object.freeze({ isBlocked: false, probability: 0 });

const isHandler = (value: unknown): value is GuardrailHandler =>
  typeof value === "object" &&
  value !== null &&
  "check" in value &&
  typeof value.check === "function";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What the class is asked (#1289): one content — the masked text with the text of the files that are
 * text appended to it (a transcription, a CSV: no coverage is lost), and every file as it is; `files`
 * is `[]` when the model reads none.
 */
export const contentOf = (checked: GuardedText): GuardrailContent => ({
  text: (checked.files ?? []).length === 0 ? checked.text : textOfGuarded(checked),
  files: (checked.files ?? []).map((file) => file.content),
  component: checked.component,
  side: checked.side,
});

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
        reason: "its class has no check(content)",
      });
    let verdict: unknown;
    try {
      verdict = await instance.check(contentOf(checked));
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
          "check(content) returned no GuardrailVerdict — return GuardrailVerdict.passed() or .blocked()",
      });
    if (!verdict.isBlocked) return PASSED;
    return verdict.refusal === undefined ? BLOCKED : { ...BLOCKED, refusal: verdict.refusal };
  };
}
