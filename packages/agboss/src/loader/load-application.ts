import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationDeclarationOf } from "../application/application.js";
import type { Class } from "../components/injection.js";
import { ApplicationLoadError } from "./load-errors.js";
import { registerTypeScript } from "./typescript.js";
import { lazyLoad } from "../infrastructure/clock.js";

/**
 * The application of the `agboss` CLI (#268): the module its path names — `"agboss": { "application" }`
 * in `package.json`, or `--application <path>` — exports exactly one `@Application` class.
 */

const isApplicationClass = (value: unknown): value is Class =>
  typeof value === "function" && applicationDeclarationOf(value as Class) !== undefined;

/** The one exported `@Application` class of a module file. */
export async function loadApplicationClass(
  path: string,
  options: { readonly typescript?: boolean } = {},
): Promise<Class> {
  const file = resolve(path);
  if (!existsSync(file)) throw new ApplicationLoadError(`Application file not found: ${file}`);
  if (options.typescript !== false) await registerTypeScript();
  const module = (await lazyLoad(import(pathToFileURL(file).href))) as Record<string, unknown>;
  const found = [...new Set(Object.values(module).filter(isApplicationClass))];
  const [application] = found;
  if (found.length !== 1 || application === undefined) {
    throw new ApplicationLoadError(
      `${file}: expected exactly one exported @Application class, found ${String(found.length)}`,
    );
  }
  return application;
}
