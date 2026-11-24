import { AGBossError, type MessageErrorOptions } from "../core/errors.js";

/** Why a profile cannot be used: what `ProfileError.reason` tells apart. */
export enum ProfileErrorReason {
  /** A profile name that no `src/config/<name>.config.*` file carries. */
  Unknown = "unknown",
  /** Both `<name>.config.ts` and `<name>.config.yaml` exist. */
  Duplicate = "duplicate",
  /** A name that is not a profile name, or listed twice. */
  BadName = "bad-name",
  /** A file whose content is not a valid profile: a typo in a key, a wrong value, the wrong export. */
  Invalid = "invalid",
  /** A profile that tries what a profile may not: enable a disabled feature, read the process environment. */
  Forbidden = "forbidden",
}

/** What a `ProfileError` takes: the sentence (names and paths, never a value) and the reason. */
export interface ProfileErrorOptions extends MessageErrorOptions {
  readonly reason?: ProfileErrorReason;
}

/**
 * A profile that cannot be used (`src/config/<name>.config.ts|yaml`): unknown, duplicated, invalid or
 * forbidden — found at assembly, before any model call. Its message names files and keys, never values.
 */
export class ProfileError extends AGBossError {
  static override readonly code = "config.profile" as const;
  declare readonly code: typeof ProfileError.code;
  override name = "ProfileError";
  /** Which way the profile cannot be used. */
  readonly reason: ProfileErrorReason;

  constructor(options: ProfileErrorOptions) {
    super(options.message, options);
    this.reason = options.reason ?? ProfileErrorReason.Invalid;
  }
}

/** A profile file that is no valid profile: `<file>: <path and rule>`, never a value. */
export const invalidProfile = (file: string, detail: string): ProfileError =>
  new ProfileError({ reason: ProfileErrorReason.Invalid, message: `${file}: ${detail}` });

/** A profile file that tries what a profile may not do. */
export const forbiddenProfile = (file: string, detail: string): ProfileError =>
  new ProfileError({ reason: ProfileErrorReason.Forbidden, message: `${file}: ${detail}` });
