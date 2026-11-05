// Packages a user's install of the packed packages must not contain (#791): `extract-zip` has
// advisories with no fixed release (GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3); it came with
// `@langchain/langgraph-cli`, which `agboss studio` no longer needs. Two checks: the files a real
// install wrote (check:packed), and the production tree the lockfile resolves for a workspace
// (the CLI's package test, in `make check`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const FORBIDDEN_PACKAGES = ["extract-zip"];

const nameOf = (dir) => {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")).name;
  } catch {
    return undefined;
  }
};

/** Every package folder under `nodeModules`, nested ones too (scopes opened, links not followed). */
function* packagesUnder(nodeModules) {
  if (!existsSync(nodeModules)) return;
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(dir, { withFileTypes: true }))
        if (scoped.isDirectory()) {
          yield join(dir, scoped.name);
          yield* packagesUnder(join(dir, scoped.name, "node_modules"));
        }
      continue;
    }
    yield dir;
    yield* packagesUnder(join(dir, "node_modules"));
  }
}

/** The folders, relative to `project`, where an install put one of `names`. */
export function installedForbiddenOf(project, names = FORBIDDEN_PACKAGES) {
  const found = [];
  for (const dir of packagesUnder(join(project, "node_modules"))) {
    const name = nameOf(dir);
    if (name !== undefined && names.includes(name)) found.push(relative(project, dir));
  }
  return found;
}

/** Where npm resolves `name` from the lockfile entry at `from`: its own node_modules, then up. */
function resolveIn(packages, from, name) {
  let base = from;
  for (;;) {
    const key = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (packages[key] !== undefined) return key;
    if (base === "") return undefined;
    const at = base.lastIndexOf("/node_modules/");
    base = at < 0 ? "" : base.slice(0, at);
  }
}

/** The lockfile entry `key` stands for — a workspace link's own — and the key it is found at. */
function entryAt(packages, key) {
  const entry = packages[key];
  if (entry?.link !== true) return { own: key, entry };
  return { own: entry.resolved, entry: packages[entry.resolved] };
}

/** What an install of `entry` installs too: dependencies, optional ones and required peers. */
function installedWith(entry) {
  const optionalPeers = entry.peerDependenciesMeta ?? {};
  return [
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}).filter((name) => !optionalPeers[name]?.optional),
  ];
}

/**
 * The chains (`@agboss/cli > a > extract-zip`) by which the lockfile `lock` installs one of `names`
 * for the workspace at `workspace` (`packages/agboss-cli`) as a user gets it: its `dependencies`, then
 * each package's `dependencies`, `optionalDependencies` and required `peerDependencies` — never a
 * `devDependencies`.
 */
export function lockfileForbiddenOf(lock, workspace, names = FORBIDDEN_PACKAGES) {
  const packages = lock.packages;
  const chains = [];
  const seen = new Set();
  const queue = [{ key: workspace, chain: [packages[workspace]?.name ?? workspace] }];
  while (queue.length > 0) {
    const { key, chain } = queue.shift();
    const { own, entry } = entryAt(packages, key);
    if (seen.has(own) || entry === undefined) continue;
    seen.add(own);
    for (const name of installedWith(entry)) {
      const found = resolveIn(packages, own, name);
      if (found === undefined) continue;
      const next = [...chain, name];
      if (names.includes(name)) chains.push(next.join(" > "));
      queue.push({ key: found, chain: next });
    }
  }
  return chains;
}
