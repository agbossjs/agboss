import { DecidedBy, GuardrailVerdict, OutputGuardrail, type GuardrailContent } from "@agboss/core";

/** Blocks an answer that promises what the desk cannot (#383: by code, on the answer). */
@OutputGuardrail({
  name: "no-promises-guardrail",
  description: "Blocks answers that guarantee a delivery date",
  decidedBy: DecidedBy.Code,
  refusal: "We will follow up with a confirmed delivery date.",
})
export class NoPromisesGuardrail {
  check({ text }: GuardrailContent): GuardrailVerdict {
    return /\bguarantee/iu.test(text) ? GuardrailVerdict.blocked() : GuardrailVerdict.passed();
  }
}
