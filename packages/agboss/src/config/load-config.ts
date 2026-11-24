import { loadProfiles } from "./config-files.js";
import { foldedConfigOf, type FoldedConfig } from "./fold-config.js";
import { selectedProfilesOf, type ProfileSelection } from "./profile-names.js";

/** Which profiles an application is built with. */
export interface ProfileChoice {
  /** The profiles, layered left to right: `"prod"`, `"prod,economy"`, `["prod", "economy"]`. */
  readonly profile?: ProfileSelection | undefined;
  /** What none named falls back to: `dev` for `createApp` and the CLI, `test` for `testWith`. */
  readonly defaultProfile: string;
}

/**
 * The selected profiles — `src/config/<name>.config.ts|yaml` next to the application file, `base`
 * first — folded into one config. An unknown named profile, a duplicate file or a file that is no
 * valid profile fails here, before anything is assembled.
 */
export async function foldedConfigFor(
  source: string | undefined,
  choice: ProfileChoice,
): Promise<FoldedConfig> {
  const selected = selectedProfilesOf(choice.profile, choice.defaultProfile);
  return foldedConfigOf(selected.names, await loadProfiles(source, selected));
}
