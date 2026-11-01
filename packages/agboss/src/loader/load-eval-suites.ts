import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationDeclarationOf } from "../application/application.js";
import { startsOfApplication } from "../application/application-starts.js";
import type { Class } from "../components/injection.js";
import { evalSuiteOf } from "../eval/suite/eval-suite.decorator.js";
import { registerTypeScript } from "./typescript.js";
import { lazyLoad } from "../infrastructure/clock.js";

/**
 * The eval suites of an application (#396 PR 2): every `eval-suites/*.eval-suite.ts` under the
 * folder of its `@Application` file (any depth; `node_modules` and dot folders skipped), each
 * module's exported `@EvalSuite` classes whose start is one of the application's (a suite of another
 * application in the same folder is its own), in file order — what `agboss eval run --suite <name>`
 * chooses from and `agboss check` checks.
 */

/** One suite found: its file, its class and its `name`. */
export interface FoundEvalSuite {
  readonly file: string;
  readonly suite: Class;
  readonly name: string;
}

const SUITE_FILE = /\.eval-suite\.(ts|mts|js|mjs)$/;
const SUITE_FOLDER = "eval-suites";

const isSkipped = (name: string): boolean => name === "node_modules" || name.startsWith(".");

/** The suite files under `dir`, sorted. */
function suiteFilesIn(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (isSkipped(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...suiteFilesIn(path));
    else if (basename(dir) === SUITE_FOLDER && SUITE_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

/** The exported suites of one module. */
async function suitesOf(file: string, starts: ReadonlySet<Class>): Promise<FoundEvalSuite[]> {
  const module = (await lazyLoad(import(pathToFileURL(file).href))) as Readonly<
    Record<string, unknown>
  >;
  return [...new Set(Object.values(module))].flatMap((value) => {
    if (typeof value !== "function") return [];
    const meta = evalSuiteOf(value as Class);
    if (meta === undefined || !starts.has(meta.start)) return [];
    return [{ file, suite: value as Class, name: meta.name }];
  });
}

/** Every suite of the application; none when its file is not known (a class built in a test). */
export async function loadEvalSuites(
  application: Class,
  options: { readonly typescript?: boolean } = {},
): Promise<readonly FoundEvalSuite[]> {
  const source = applicationDeclarationOf(application)?.source;
  if (source === undefined) return [];
  const root = dirname(source);
  if (!existsSync(root)) return [];
  const files = suiteFilesIn(root);
  if (files.length > 0 && options.typescript !== false) await registerTypeScript();
  const starts = new Set(startsOfApplication(application).map((start) => start.component));
  const found: FoundEvalSuite[] = [];
  for (const file of files) found.push(...(await suitesOf(file, starts)));
  return found;
}
