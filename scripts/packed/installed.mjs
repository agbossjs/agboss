// "Installed, not linked" (#497): the project's @agboss/core is a copy in its own node_modules — the
// packed package, external to vitest as a user's is — never a workspace link, and the only copy.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

const CORE = join("node_modules", "@agboss", "core");
/** Where a second copy would be if the CLI's dependency were not deduped onto the tarball. */
const NESTED = join("node_modules", "@agboss", "cli", "node_modules", "@agboss", "core");

const nameOf = (dir) => {
  const file = join(dir, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).name : undefined;
};

/** Why the project's @agboss/core is not an installed copy; undefined when it is. */
export function installedCoreProblem(project) {
  const core = join(project, CORE);
  if (!existsSync(core)) return `${CORE} is missing in ${project}`;
  if (lstatSync(core).isSymbolicLink())
    return `${CORE} is a link to ${realpathSync(core)}, not an installed package`;
  if (nameOf(core) !== "@agboss/core") return `${CORE}/package.json is not @agboss/core's`;
  const real = relative(realpathSync(project), realpathSync(core));
  if (real !== CORE) return `${CORE} resolves outside the project's node_modules (${real})`;
  if (existsSync(join(project, NESTED))) return `a second @agboss/core is installed at ${NESTED}`;
  return undefined;
}
