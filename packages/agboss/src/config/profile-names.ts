import { ProfileError, ProfileErrorReason } from "./profile-error.js";

/** The profile an application and the CLI run with when none is named. */
export const APP_DEFAULT_PROFILE = "dev";
/** The profile a test runs with when none is named: its own, never dev's values. */
export const TEST_DEFAULT_PROFILE = "test";
/** The shared base every selection starts from, when `base.config.*` exists. */
export const BASE_PROFILE = "base";

/** Which profiles to run with: `"prod"`, `"prod,economy"`, `"prod+economy"` or `["prod", "economy"]`. */
export type ProfileSelection = string | readonly string[];

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The profiles a selection names, in layering order; `undefined` = the default alone. */
export interface SelectedProfiles {
  readonly names: readonly string[];
  /** Whether the caller named them (an unknown named profile fails; an unknown default is none). */
  readonly isExplicit: boolean;
}

const partsOf = (selection: ProfileSelection): string[] =>
  (typeof selection === "string" ? [selection] : selection).flatMap((item) => item.split(/[,+]/));

/** The profile names of a selection, validated; fails closed on an empty, malformed or repeated name. */
export function selectedProfilesOf(
  selection: ProfileSelection | undefined,
  fallback: string,
): SelectedProfiles {
  if (selection === undefined) return { names: [fallback], isExplicit: false };
  const names = partsOf(selection).map((part) => part.trim());
  if (names.length === 0 || names.some((name) => name === ""))
    throw new ProfileError({
      reason: ProfileErrorReason.BadName,
      message: "profile: an empty profile name — name each profile, e.g. --profile prod,economy",
    });
  for (const name of names) {
    if (!NAME.test(name))
      throw new ProfileError({
        reason: ProfileErrorReason.BadName,
        message: `profile "${name}": a profile name is lowercase letters, digits and dashes`,
      });
  }
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined)
    throw new ProfileError({
      reason: ProfileErrorReason.BadName,
      message: `profile "${repeated}" is listed twice`,
    });
  return { names, isExplicit: true };
}
