import { env } from "agboss";
import type { AppEnvironment } from "./app.environment.js";

/** No --env: the ledger in `.agboss/flow-patterns.sqlite` (git-ignored) unless AGBOSS_SQLITE_PATH says otherwise. */
export const environment: AppEnvironment = {
  sqlitePath: env("AGBOSS_SQLITE_PATH", { default: ".agboss/flow-patterns.sqlite" }),
};
