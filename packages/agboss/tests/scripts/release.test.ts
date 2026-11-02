/**
 * #691 AC1 — the release workflow (`.github/workflows/release.yml`) publishes `@agboss/core`, then
 * `@agboss/cli`, only on a tag `vX.Y.Z` that is both packages' version, the CLI on exactly that
 * core (`scripts/release/release-plan.mjs`), and only after CI passed on a push of that exact commit
 * (`scripts/release/ci-gate.mjs`, which every package of the train copies).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = new URL("../../../../", import.meta.url).pathname;

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}
interface ReleasePlan {
  readonly CORE_PACKAGES: readonly { readonly name: string; readonly folder: string }[];
  readonly versionOfTag: (tag: string) => string | undefined;
  readonly releaseProblemsOf: (input: {
    readonly tag: string | undefined;
    readonly packages: readonly Manifest[];
  }) => readonly string[];
}
interface Run {
  readonly head_sha: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
}
interface CiGate {
  readonly ciVerdictOf: (runs: readonly Run[], sha: string) => string;
  readonly ciGateOptionsOf: (args: readonly string[]) => {
    readonly sha: string;
    readonly workflow: string;
    readonly timeoutMinutes: number;
  };
}
const plan = (await import(join(repo, "scripts/release/release-plan.mjs"))) as ReleasePlan;
const gate = (await import(join(repo, "scripts/release/ci-gate.mjs"))) as CiGate;

const SHA = "c".repeat(40);
const core: Manifest = { name: "@agboss/core", version: "0.1.1" };
const cli: Manifest = {
  name: "@agboss/cli",
  version: "0.1.1",
  dependencies: { "@agboss/core": "0.1.1" },
};

describe("AC1: the release plan of the core", () => {
  it("AC1: publishes the core first, then the CLI — this repository's two packages, one version", () => {
    expect(plan.CORE_PACKAGES.map((pkg) => pkg.name)).toEqual(["@agboss/core", "@agboss/cli"]);
    const manifests = plan.CORE_PACKAGES.map(
      ({ folder }) =>
        JSON.parse(readFileSync(join(repo, folder, "package.json"), "utf8")) as Manifest,
    );
    expect(plan.releaseProblemsOf({ tag: undefined, packages: manifests })).toEqual([]);
  });

  it("AC1: the tag of the packages' version is ready", () => {
    expect(plan.releaseProblemsOf({ tag: "v0.1.1", packages: [core, cli] })).toEqual([]);
    expect(plan.versionOfTag("v0.1.1")).toBe("0.1.1");
  });

  it("AC1: a tag of another version, or no release tag, is refused", () => {
    expect(plan.releaseProblemsOf({ tag: "v0.1.2", packages: [core, cli] })).toEqual([
      "the tag v0.1.2 is not v0.1.1, the packages' version",
    ]);
    expect(plan.versionOfTag("postgres-v0.1.1")).toBeUndefined();
    expect(plan.versionOfTag("v0.1.1-rc.1")).toBeUndefined();
  });

  it("AC1: two versions, or a CLI on another core, are refused", () => {
    expect(
      plan.releaseProblemsOf({ tag: "v0.1.1", packages: [core, { ...cli, version: "0.1.0" }] }),
    ).toEqual(["@agboss/cli is 0.1.0, @agboss/core 0.1.1: one version for the release"]);
    expect(
      plan.releaseProblemsOf({
        tag: "v0.1.1",
        packages: [core, { ...cli, dependencies: { "@agboss/core": "^0.1.1" } }],
      }),
    ).toEqual(["@agboss/cli depends on @agboss/core ^0.1.1, not exactly 0.1.1"]);
  });
});

describe("AC1: CI on that exact commit", () => {
  const run = (overrides: Partial<Run>): Run => ({
    head_sha: SHA,
    event: "push",
    status: "completed",
    conclusion: "success",
    ...overrides,
  });

  it("AC1: a successful push run passes, one still running waits, a failed one fails", () => {
    expect(gate.ciVerdictOf([run({ conclusion: "failure" }), run({})], SHA)).toBe("passed");
    expect(gate.ciVerdictOf([run({ status: "queued", conclusion: null })], SHA)).toBe("pending");
    expect(gate.ciVerdictOf([run({ conclusion: "failure" })], SHA)).toBe("failed");
  });

  it("AC1: a pull request's run or another commit's does not count", () => {
    expect(
      gate.ciVerdictOf([run({ event: "pull_request" }), run({ head_sha: "d".repeat(40) })], SHA),
    ).toBe("missing");
    expect(() => gate.ciGateOptionsOf(["--sha", "main"])).toThrow(/full commit SHA/);
    expect(gate.ciGateOptionsOf(["--sha", SHA, "--timeout-minutes", "5"]).timeoutMinutes).toBe(5);
  });
});
