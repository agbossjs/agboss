import { configureEnv, defineConfig } from "../../../../src/index.js";
import { overrideEnv, PROFILE_DATABASE } from "../override-env.js";

/** A profile that moves the database: the storage must open this file, not the variable's default. */
export default defineConfig({
  env: configureEnv(overrideEnv, { databasePath: PROFILE_DATABASE }),
});
