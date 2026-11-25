import type { AppEnvironment } from "./app.environment.js";

/**
 * The desk run for real but offline (`desk-application`: the transport model only): no model key.
 * Its stores are `DeskDatabaseStorage`'s — `.agboss/desk-offline.sqlite` (git-ignored;
 * AGBOSS_SQLITE_PATH overrides it), so its kept executions outlive the run, for `agboss records
 * export` and `agboss generate eval-case --from-execution` — with the PII key of its variable
 * (PII_PSEUDONYM_KEY: any value, it only makes tokens).
 * `agboss run` / `agboss eval run --env offline`.
 */
export const environment: AppEnvironment = {};
