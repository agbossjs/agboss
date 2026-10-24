import { env, secret } from "agboss";
import type { AppEnvironment } from "./app.environment.js";

/**
 * The desk run for real but offline (`desk-application`: the transport model only): no model key,
 * the stores in `.agboss/desk-offline.sqlite` (git-ignored; AGBOSS_SQLITE_PATH overrides it) — so
 * its kept executions outlive the run, for `agboss records export` and `agboss generate eval-case
 * --from-execution` — and the PII key from PII_PSEUDONYM_KEY — any value, it only makes tokens —
 * which the desk's PII policy needs outside tests. `agboss run` / `agboss eval run --env offline`.
 */
export const environment: AppEnvironment = {
  sqlitePath: env("AGBOSS_SQLITE_PATH", { default: ".agboss/desk-offline.sqlite" }),
  piiPseudonymKey: secret("PII_PSEUDONYM_KEY"),
};
