import type { AppEnvironment } from "./app.environment.js";

/** `npm run chat` (no --env): the public Greenhouse API. */
export const environment: AppEnvironment = {
  greenhouseApiUrl: "https://boards-api.greenhouse.io",
};
