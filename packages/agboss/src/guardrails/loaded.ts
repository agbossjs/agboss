import type { Class } from "../components/injection.js";
import type { GuardrailSide } from "../components/policy-decorators.js";
import { DecidedBy } from "../flow/decorators/router.js";

/**
 * A guardrail as assembled (#120, #383): decided by its model — its question read, its model
 * resolved — or by its class's `check(text)`. Small and import-light: model resolution and the
 * versions read it.
 */

/** What every assembled guardrail has. */
export interface LoadedGuardrailBase {
  readonly type: Class;
  readonly name: string;
  readonly description: string;
  readonly side: GuardrailSide;
  /** Its fixed refusal; absent → the class's `refusal()`. */
  readonly refusal?: string;
}

/** One guardrail ready to ask its model. */
export interface LoadedModelGuardrail extends LoadedGuardrailBase {
  readonly decidedBy: DecidedBy.Model;
  /** Its question, read and rendered: yes blocks. */
  readonly prompt: string;
  readonly threshold: number;
  /** Its own model, else `defaults.guardrail.model`. */
  readonly model: string;
  /** Whether `model` is its own (else the default's). */
  readonly isOwnModel: boolean;
}

/** One guardrail its class decides (#383): `check(text)` on the container's instance. */
export interface LoadedCodeGuardrail extends LoadedGuardrailBase {
  readonly decidedBy: DecidedBy.Code;
}

/** One assembled guardrail: decided by its model or by its class. */
export type LoadedGuardrail = LoadedModelGuardrail | LoadedCodeGuardrail;

/** Whether an assembled guardrail asks a model. */
export const isModelGuardrail = (guardrail: LoadedGuardrail): guardrail is LoadedModelGuardrail =>
  guardrail.decidedBy === DecidedBy.Model;

/** The guardrails of a workflow that ask a model (their models are resolved and checked). */
export const modelGuardrailsOf = (
  assembled: { readonly guardrails: readonly LoadedGuardrail[] } | undefined,
): readonly LoadedModelGuardrail[] => (assembled?.guardrails ?? []).filter(isModelGuardrail);
