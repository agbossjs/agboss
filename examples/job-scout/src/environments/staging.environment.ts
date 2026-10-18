import { env } from "agboss";
import type { AppEnvironment } from "./app.environment.js";

/** `--env staging`: the board API from the deployment (GREENHOUSE_API_URL and AGBOSS_SQLITE_PATH must be set). */
export const environment: AppEnvironment = {
  greenhouseApiUrl: env("GREENHOUSE_API_URL"),
  sqlitePath: env("AGBOSS_SQLITE_PATH"),
};
