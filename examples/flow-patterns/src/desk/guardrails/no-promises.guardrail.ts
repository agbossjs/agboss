import { DecidedBy, GuardrailVerdict, OutputGuardrail, type GuardrailHandler } from "agboss";

/** Blocks an answer that promises what the desk cannot (#383: by code, on the answer). */
@OutputGuardrail({
  name: "no-promises-guardrail",
  description: "Blocks answers that guarantee a delivery date",
  decidedBy: DecidedBy.Code,
  refusal: "We will follow up with a confirmed delivery date.",
})
export class NoPromisesGuardrail implements GuardrailHandler {
  check(text: string): GuardrailVerdict {
    return /\bguarantee/iu.test(text) ? GuardrailVerdict.blocked() : GuardrailVerdict.passed();
  }
}
