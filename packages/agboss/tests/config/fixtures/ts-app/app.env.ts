import { defineEnv, env, secret } from "../../../../src/index.js";

/** The one place this application reads the process's variables. */
export const appEnv = defineEnv({
  region: env("TS_APP_REGION", { default: "eu" }),
  retries: env.integer("TS_APP_RETRIES", { default: 3 }),
  apiKey: secret.optional("TS_APP_API_KEY"),
});
