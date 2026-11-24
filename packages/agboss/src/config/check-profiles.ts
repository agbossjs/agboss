import type { Class } from "../components/injection.js";
import { applicationOf } from "../application/assemble.js";
import { requireApplication } from "../application/application.js";
import { availableProfiles, configDirOf, configFileOf, configFilesOf } from "./config-files.js";
import { BASE_PROFILE } from "./profile-names.js";

/** One profile of `src/config/` that cannot be used: which, in which file, and why (no value in it). */
export interface ProfileProblem {
  readonly profile: string;
  readonly file: string;
  readonly message: string;
}

/**
 * Every profile of `src/config/` — the inactive ones too — assembled with the application, schema-only:
 * duplicates, typos, unknown agents, workflows and providers, models no provider serves. Nothing
 * resolves a `defineEnv` value or reads a secret, so it needs none of them.
 */
export async function profileProblemsOf(
  application: Class,
  where: string,
): Promise<readonly ProfileProblem[]> {
  const { source } = requireApplication(application, where);
  if (source === undefined) return [];
  const dir = configDirOf(source);
  const files = configFilesOf(dir);
  const problems: ProfileProblem[] = [];
  for (const profile of availableProfiles(files)) {
    const file = files.find((one) => one.name === profile)?.file ?? dir;
    try {
      configFileOf(files, profile);
      if (profile !== BASE_PROFILE || files.some((one) => one.name === profile))
        await applicationOf(
          application,
          { profile: [profile], withoutIdempotencyKeys: true },
          where,
        );
    } catch (error) {
      problems.push({
        profile,
        file,
        message: (error instanceof Error ? error.message : String(error)).split("\n").join(" "),
      });
    }
  }
  return problems;
}
