/**
 * `@agboss/core/testing/vitest` (#497) — the vitest preset of a project:
 *
 * ```ts
 * // vitest.config.ts
 * import { defineConfig } from "vitest/config";
 * import { agbossTest } from "@agboss/core/testing/vitest";
 *
 * export default defineConfig({ test: agbossTest({ include: ["tests/**\/*.test.ts"] }) });
 * ```
 *
 * Installed from npm, `@agboss/core` is an external dependency of vitest: Node loads it, and every
 * project file it loads by path (the application `workflowOf` looks for, its environments, eval
 * suites) bypasses vite — no decorators, and a second module graph. Inlined, the core and the files
 * it loads go through vite, in the test's graph. Types only from vitest: no runtime dependency.
 */
import type { ViteUserConfig } from "vitest/config";

/** The `test` options of a vitest config. */
export type VitestTestOptions = NonNullable<ViteUserConfig["test"]>;

type ServerOptions = NonNullable<VitestTestOptions["server"]>;
type InlinedDependencies = NonNullable<NonNullable<ServerOptions["deps"]>["inline"]>;

/** The workflow matchers, `mockLlm`'s call matchers and the trajectory matchers. */
const SETUP_FILE = "@agboss/core/testing/setup";

/** The core's modules, wherever they are installed: vite processes them (`server.deps.inline`). */
const CORE_MODULES = /@agboss\/core/;

const isCorePattern = (entry: string | RegExp): boolean =>
  entry instanceof RegExp &&
  entry.source === CORE_MODULES.source &&
  entry.flags === CORE_MODULES.flags;

/** The user's setup files, then AGBoss's — once. */
function withSetupFile(given: VitestTestOptions["setupFiles"]): string[] {
  const files = typeof given === "string" ? [given] : [...(given ?? [])];
  return files.includes(SETUP_FILE) ? files : [...files, SETUP_FILE];
}

/** The user's inlined dependencies, then the core — once; `true` (all of them) covers it. */
function withCoreInlined(given: InlinedDependencies | undefined): InlinedDependencies {
  if (given === true) return true;
  const inline = [...(given ?? [])];
  return inline.some(isCorePattern) ? inline : [...inline, CORE_MODULES];
}

/**
 * The `test` options of a project's vitest config: AGBoss loaded through vite, in the test's module
 * graph, and its matchers registered. Everything else passes through unchanged; `setupFiles` and
 * `server.deps.inline` are merged with the user's, never replaced, and calling it twice adds
 * nothing twice.
 */
export function agbossTest(test: VitestTestOptions = {}): VitestTestOptions {
  const server = test.server ?? {};
  return {
    ...test,
    setupFiles: withSetupFile(test.setupFiles),
    server: { ...server, deps: { ...server.deps, inline: withCoreInlined(server.deps?.inline) } },
  };
}
