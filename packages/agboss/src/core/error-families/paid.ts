import { GuardrailError, LimitError, PiiError } from "./limit-errors.js";
import { StepError } from "./step-errors.js";

/**
 * Whether `error` is one of the paid families (#1325b): a step, a limit, a guardrail or a PII error
 * carries `usage` — the spend the ledger still has to see — and `spend`, its report.
 */
export const isPaidError = (
  error: unknown,
): error is StepError | LimitError | GuardrailError | PiiError =>
  error instanceof StepError ||
  error instanceof LimitError ||
  error instanceof GuardrailError ||
  error instanceof PiiError;
