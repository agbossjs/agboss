import { defineEnv, env } from "../../../../src/index.js";

/** The settings the tool reads: an address with a dev default, a profile's `configureEnv` changes it. */
export const profileEnv = defineEnv({
  upstream: env("PROFILE_ENV_UPSTREAM", { default: "https://dev.example" }),
  required: env("PROFILE_ENV_REQUIRED"),
  retries: env.integer("PROFILE_ENV_RETRIES", { default: 3 }),
});

/** The same variable as `profileEnv.upstream`, read without a default elsewhere. */
export const otherEnv = defineEnv({ upstream: env("PROFILE_ENV_UPSTREAM") });
