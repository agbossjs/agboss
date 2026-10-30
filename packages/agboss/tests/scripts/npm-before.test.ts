/**
 * #523 AC1 — an install that resolves ranges takes no release younger than three days:
 * `scripts/packed/npm-before.mjs` builds `npm install --before=<now − 3 days>` (`AGBOSS_NPM_BEFORE`
 * overrides the date), and `scripts/check-packed.mjs` installs the packed tarballs with it.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = new URL("../../../../", import.meta.url).pathname;

type Environment = Readonly<Record<string, string | undefined>>;
interface NpmBefore {
  readonly MINIMUM_RELEASE_AGE_DAYS: number;
  readonly NPM_BEFORE_VARIABLE: string;
  readonly NpmBeforeError: new (message: string) => Error;
  readonly npmBeforeOf: (env: Environment, now: Date) => string;
  readonly rangeInstallArguments: (
    rest: readonly string[],
    env: Environment,
    now: Date,
  ) => readonly string[];
}
interface CheckPacked {
  readonly tarballInstallArguments: (
    tarballs: readonly string[],
    env: Environment,
    now: Date,
  ) => readonly string[];
}
const npmBefore = (await import(join(repo, "scripts/packed/npm-before.mjs"))) as NpmBefore;
const checkPacked = (await import(join(repo, "scripts/check-packed.mjs"))) as CheckPacked;

const NOW = new Date("2026-10-31T12:00:00.000Z");

describe("AC1: the minimum release age of an install that resolves ranges", () => {
  it("AC1: is three days", () => {
    expect(npmBefore.MINIMUM_RELEASE_AGE_DAYS).toBe(3);
  });

  it("AC1: --before is now minus three days, to the millisecond, when nothing overrides it", () => {
    expect(npmBefore.npmBeforeOf({}, NOW)).toBe("2026-10-28T12:00:00.000Z");
  });

  it("AC1: an empty AGBOSS_NPM_BEFORE is unset", () => {
    expect(npmBefore.npmBeforeOf({ AGBOSS_NPM_BEFORE: " " }, NOW)).toBe("2026-10-28T12:00:00.000Z");
  });

  it("AC1: AGBOSS_NPM_BEFORE overrides the date (a release verified against the latest)", () => {
    expect(npmBefore.NPM_BEFORE_VARIABLE).toBe("AGBOSS_NPM_BEFORE");
    expect(npmBefore.npmBeforeOf({ AGBOSS_NPM_BEFORE: "2026-10-31T11:59:00Z" }, NOW)).toBe(
      "2026-10-31T11:59:00.000Z",
    );
  });

  it("AC1: an AGBOSS_NPM_BEFORE that is not a date fails, naming the variable and the form", () => {
    expect(() => npmBefore.npmBeforeOf({ AGBOSS_NPM_BEFORE: "yesterday" }, NOW)).toThrow(
      npmBefore.NpmBeforeError,
    );
    expect(() => npmBefore.npmBeforeOf({ AGBOSS_NPM_BEFORE: "yesterday" }, NOW)).toThrow(
      "AGBOSS_NPM_BEFORE=yesterday is not a date (ISO 8601",
    );
  });

  it("AC1: the install's arguments are install, --before, then the rest in order", () => {
    expect(npmBefore.rangeInstallArguments(["--no-audit", "a.tgz"], {}, NOW)).toEqual([
      "install",
      "--before=2026-10-28T12:00:00.000Z",
      "--no-audit",
      "a.tgz",
    ]);
  });
});

describe("AC1: check:packed installs the packed tarballs with the minimum release age", () => {
  it("AC1: the tarballs by path, their dependencies no younger than three days", () => {
    expect(checkPacked.tarballInstallArguments(["/p/core.tgz", "/p/cli.tgz"], {}, NOW)).toEqual([
      "install",
      "--before=2026-10-28T12:00:00.000Z",
      "--no-audit",
      "--no-fund",
      "/p/core.tgz",
      "/p/cli.tgz",
    ]);
  });

  it("AC1: AGBOSS_NPM_BEFORE reaches its install too", () => {
    const args = checkPacked.tarballInstallArguments(
      ["/p/core.tgz"],
      { AGBOSS_NPM_BEFORE: "2026-10-31T12:00:00Z" },
      NOW,
    );

    expect(args[1]).toBe("--before=2026-10-31T12:00:00.000Z");
  });
});
