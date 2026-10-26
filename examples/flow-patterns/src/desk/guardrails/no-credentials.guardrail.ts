import { DecidedBy, GuardrailVerdict, InputGuardrail, type GuardrailHandler } from "@agboss/core";

const CREDENTIALS = /\b(password|passcode|cvv)\b/iu;

/** Blocks a question that carries credentials, before the desk's model reads it (#383: by code). */
@InputGuardrail({
  name: "no-credentials-guardrail",
  description: "Blocks questions that carry credentials",
  decidedBy: DecidedBy.Code,
  refusal: "Please never send passwords or card codes to the help desk.",
})
export class NoCredentialsGuardrail implements GuardrailHandler {
  check(text: string): GuardrailVerdict {
    return CREDENTIALS.test(text) ? GuardrailVerdict.blocked() : GuardrailVerdict.passed();
  }
}
