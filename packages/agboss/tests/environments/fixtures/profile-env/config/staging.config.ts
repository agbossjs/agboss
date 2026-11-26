import { configureEnv, defineConfig } from "../../../../../src/index.js";
import { otherEnv, profileEnv } from "../app.env.js";

/** Differs from the base only in `configureEnv`: the address, and the otherwise required variable. */
export default defineConfig({
  env: [
    configureEnv(profileEnv, { upstream: "https://staging.example", required: "from-staging" }),
    configureEnv(otherEnv, { upstream: "https://staging.example" }),
  ],
});
