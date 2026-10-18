import type { AppEnvironment } from "./app.environment.js";

/** What `testWith(JobScoutApplication)` runs on: a host no test reaches (fetches are stubbed or recorded). */
export const environment: AppEnvironment = {
  greenhouseApiUrl: "https://greenhouse.test",
};
