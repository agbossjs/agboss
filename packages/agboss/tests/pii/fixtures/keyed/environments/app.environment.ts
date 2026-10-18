import type { Secret } from "../../../../../src/index.js";

/** The PII test applications' environment (#120): their PII key, a `Secret` field. */
export class PiiEnvironment {
  piiPseudonymKey!: Secret;
}
