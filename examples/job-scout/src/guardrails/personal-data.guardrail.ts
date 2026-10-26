import { OutputGuardrail } from "@agboss/core";

/** Every agent's answer is checked before it leaves (#120): personal data of a real person is withheld. */
@OutputGuardrail({
  name: "personal-data-guardrail",
  description: "Withholds answers that reveal personal data",
  prompt: "Does this answer reveal personal data of a real person (phone, email, address, ID)?",
  threshold: 0.7,
  refusal: "The answer contained personal data and was withheld.",
})
export class PersonalDataGuardrail {}
