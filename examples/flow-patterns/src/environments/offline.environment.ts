import { secret } from "agboss";
import type { AppEnvironment } from "./app.environment.js";

/**
 * The desk run for real but offline (`desk-application`: the transport model only): no model key,
 * the stores in memory, and the PII key from PII_PSEUDONYM_KEY — any value, it only makes tokens —
 * which the desk's PII policy needs outside tests. `agboss run` / `agboss eval run --env offline`.
 */
export const environment: AppEnvironment = {
  sqlitePath: ":memory:",
  piiPseudonymKey: secret("PII_PSEUDONYM_KEY"),
};
