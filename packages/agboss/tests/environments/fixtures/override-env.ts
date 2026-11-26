import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineEnv, env, secret } from "../../../src/index.js";

/** The file the variable's own default names: a test that finds it written was given no override. */
export const DEFAULT_DATABASE = join(
  mkdtempSync(join(tmpdir(), "agboss-override-default-")),
  "default.sqlite",
);

/** An application's `defineEnv` whose references go into a storage's options (#1324b). */
export const overrideEnv = defineEnv({
  databasePath: env("OVERRIDE_DATABASE_PATH", { default: DEFAULT_DATABASE }),
  idempotency: secret("OVERRIDE_IDEMPOTENCY"),
});

/** The file the `prod` profile moves the database to. */
export const PROFILE_DATABASE = join(
  mkdtempSync(join(tmpdir(), "agboss-override-profile-")),
  "prod.sqlite",
);
