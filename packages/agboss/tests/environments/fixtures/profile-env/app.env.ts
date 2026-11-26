import { defineEnv, env } from "../../../../src/index.js";

/** The settings the tool reads: an address with a dev default, a profile's `configureEnv` changes it. */
export const profileEnv = defineEnv({
  upstream: env("PROFILE_ENV_UPSTREAM", { default: "https://dev.example" }),
  required: env("PROFILE_ENV_REQUIRED"),
});
