#!/usr/bin/env node
// What a release of the core may publish (#691 AC1), checked before anything is: the tag `vX.Y.Z`
// is the version of both packages of this repository, `@agboss/core` and `@agboss/cli` (the train's
// first car — every other package of it is published after, on this core from npm), and the CLI
// depends on exactly that core. A publish refuses on any problem; a dry run (`--dry-run`, on pull
// requests) takes the version the packages have as the tag they would get.
//   node scripts/release/release-plan.mjs --tag v0.1.1   # the publish job
//   node scripts/release/release-plan.mjs --dry-run      # the dry run
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^\d+\.\d+\.\d+$/u;

/** The packages of the core's release, in the order they are published. */
export const CORE_PACKAGES = Object.freeze([
  { name: "@agboss/core", folder: "packages/agboss" },
  { name: "@agboss/cli", folder: "packages/agboss-cli" },
]);

/** The version a tag names (`v0.1.1` → `0.1.1`), or `undefined` when it is no release tag. */
export function versionOfTag(tag) {
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  return VERSION.test(version) ? version : undefined;
}

/**
 * Every problem of a release of `packages` (`[{ name, version, dependencies? }]`, the core first):
 * one version for all, X.Y.Z, the tag's (when a tag is given), and the CLI's `@agboss/core` that
 * exact version.
 */
export function releaseProblemsOf({ tag, packages }) {
  const problems = [];
  const [core] = packages;
  for (const pkg of packages) {
    if (!VERSION.test(pkg.version))
      problems.push(`${pkg.name}'s version ${pkg.version} is not X.Y.Z`);
    if (pkg.version !== core.version)
      problems.push(
        `${pkg.name} is ${pkg.version}, ${core.name} ${core.version}: one version for the release`,
      );
    const onCore = pkg.dependencies?.[core.name];
    if (pkg !== core && onCore !== core.version)
      problems.push(
        `${pkg.name} depends on ${core.name} ${String(onCore)}, not exactly ${core.version}`,
      );
  }
  if (tag !== undefined && versionOfTag(tag) !== core.version)
    problems.push(`the tag ${tag} is not v${core.version}, the packages' version`);
  return problems;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function main(args) {
  const isDryRun = args.includes("--dry-run");
  const at = args.indexOf("--tag");
  const tag = at === -1 ? undefined : args[at + 1];
  if (!isDryRun && tag === undefined) throw new Error("--tag vX.Y.Z or --dry-run");
  const packages = CORE_PACKAGES.map(({ folder }) =>
    JSON.parse(readFileSync(join(ROOT, folder, "package.json"), "utf8")),
  );
  const problems = releaseProblemsOf({ tag, packages });
  for (const problem of problems) console.error(`[release-plan] problem: ${problem}`);
  if (problems.length > 0) return 1;
  const listed = packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", then ");
  console.log(`[release-plan] v${packages[0].version}: ${listed}${isDryRun ? " (dry run)" : ""}`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`[release-plan] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
