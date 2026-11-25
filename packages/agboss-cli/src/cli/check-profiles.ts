import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configJsonSchemaOf, profileProblemsOf } from "@agboss/core/internal";
import type { CliApplication } from "./cli-application.js";
import type { Assembly, CheckProblem } from "./check-problems.js";
import { packageDirOf } from "./project-env.js";

/** `.agboss/config.schema.json` of the project (for `# $schema:` in a `.config.yaml`). */
export const CONFIG_SCHEMA = join(".agboss", "config.schema.json");

/**
 * The profiles of `src/config/` checked as one set (#1318): each assembled with the application,
 * inactive ones too, schema-only — no variable and no secret is read — and the project-typed JSON
 * Schema of a `.config.yaml` written next to the generated types.
 */
export async function profileCheckOf(
  loaded: CliApplication,
  assembly: Assembly,
): Promise<readonly CheckProblem[]> {
  if (assembly.kind === "failed") return [];
  const assembled = assembly.assembled;
  const found = await profileProblemsOf(loaded.application, "agboss check");
  const dir = packageDirOf(loaded.path.file);
  // only a project that has a src/config/ next to its application gets one
  if (dir !== undefined && existsSync(join(dirname(loaded.path.file), "config"))) {
    mkdirSync(join(dir, ".agboss"), { recursive: true });
    writeFileSync(
      join(dir, CONFIG_SCHEMA),
      `${JSON.stringify(configJsonSchemaOf(assembled), null, 2)}\n`,
    );
  }
  return found.map((problem) => ({
    file: problem.file,
    code: "profile.invalid",
    message: problem.message,
  }));
}
