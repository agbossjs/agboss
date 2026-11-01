import { fileURLToPath } from "node:url";
import { lazyLoad } from "../infrastructure/clock.js";

/**
 * Workflows are TypeScript with decorators: Node's type stripping cannot run them, tsx can
 * (transpile-only — no type check, so a stale or missing `.agboss/types.d.ts` never blocks loading,
 * #272 S2). The registration records every module tsx loads from then on, so type generation can
 * find the module each class is exported from (`moduleNamespace[Cls.name] === Cls`).
 */

let isRegistered = false;
const imported = new Set<string>();

const SCRIPT = /\.[cm]?[jt]sx?$/;

/** A project module: a script file of its own, not a package's. */
const isProjectModule = (url: string): boolean =>
  url.startsWith("file:") && !url.includes("/node_modules/") && SCRIPT.test(url);

export async function registerTypeScript(): Promise<void> {
  if (isRegistered) return;
  const { register } = await lazyLoad(import("tsx/esm/api"));
  register({
    onImport: (url) => {
      if (isProjectModule(url)) imported.add(fileURLToPath(url));
    },
  });
  isRegistered = true;
}

/** The project modules loaded through tsx so far (absolute paths, sorted). */
export const importedModules = (): readonly string[] => [...imported].sort();
