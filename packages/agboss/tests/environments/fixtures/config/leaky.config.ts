import { configureEnv, defineConfig } from "../../../../src/index.js";
import { overrideEnv } from "../override-env.js";

/** A profile that tries to write a secret into the repository: refused. */
export default defineConfig({
  env: configureEnv(overrideEnv, { idempotency: "from-a-profile" as never }),
});
