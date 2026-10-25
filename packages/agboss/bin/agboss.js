#!/usr/bin/env node
// Proxy launcher: inside a project with `agboss-cli` installed, imports and runs its `bin/agboss.js`
// in-process; in an empty directory (e.g. `npx agboss create my-app`), delegates via `npx` to
// `agboss-cli@<version>` (or `AGBOSS_CLI_PACKAGE_SPEC`) without adding `agboss-cli` to `agboss` dependencies.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolveCliFrom(basePath) {
  try {
    const resolved = createRequire(basePath).resolve("agboss-cli/bin/agboss.js");
    if (existsSync(resolved)) return resolved;
  } catch {
    // not installed at this location
  }
  return undefined;
}

function findLocalCli() {
  let dir = resolve(process.cwd());
  while (true) {
    const fromRequire = resolveCliFrom(join(dir, "package.json"));
    if (fromRequire !== undefined) return fromRequire;
    const candidate = join(dir, "node_modules", "agboss-cli", "bin", "agboss.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolveCliFrom(import.meta.url);
}

const localCli = findLocalCli();
if (localCli !== undefined) {
  await import(pathToFileURL(localCli).href);
} else {
  const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  const customSpec = process.env.AGBOSS_CLI_PACKAGE_SPEC?.trim();
  const spec = customSpec || `agboss-cli@${pkg.version}`;
  const packageFlags = [];
  if (customSpec) {
    const cleanPath = customSpec.startsWith("file:") ? customSpec.slice(5) : customSpec;
    if (cleanPath.endsWith(".tgz")) {
      const siblingTarball = join(dirname(resolve(cleanPath)), `agboss-${pkg.version}.tgz`);
      packageFlags.push(`--package=${existsSync(siblingTarball) ? siblingTarball : pkgRoot}`);
    }
  }
  packageFlags.push(`--package=${spec}`);
  const result = spawnSync(
    "npx",
    ["--yes", ...packageFlags, "agboss-cli", ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (result.error) {
    process.stderr.write(`agboss: failed to launch agboss-cli via npx: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
