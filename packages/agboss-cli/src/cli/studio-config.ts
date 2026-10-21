import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Class } from "agboss";
import { CliError } from "./errors.js";

/**
 * The Studio config `agboss studio` writes into the project's git-ignored `.agboss/` (#268 AC7): a
 * module whose exports are the application's workflows, built by `studioOf` — children inside their
 * parent (#263 S37) — and the `langgraph.json` that names them. The project keeps neither a
 * `studio.ts` nor a `langgraph.json` of its own; both are rewritten on every run.
 */

/** The folder of the generated files, next to `.agboss/types.d.ts`. */
export const STUDIO_FOLDER = ".agboss";
/** The module LangGraph loads the graphs from. */
export const STUDIO_ENTRY = "studio.ts";
/** The LangGraph CLI's config (`langgraphjs dev --config …`). */
export const STUDIO_CONFIG = "langgraph.json";

/** What the generated module imports and builds. */
export interface StudioSource {
  /** The application module, absolute. */
  readonly file: string;
  /** Its `@Application` class, as the module exports it. */
  readonly application: Class;
  /** The workflows' names, in the application's order: one graph each. */
  readonly workflows: readonly string[];
  /** `--env <name>`; undefined = the default (`dev`). */
  readonly env: string | undefined;
}

/** The written files, absolute, and the graph of each workflow as `langgraph.json` names it. */
export interface StudioFiles {
  readonly entry: string;
  readonly config: string;
  /** The workflow's name → `./studio.ts:<export>`. */
  readonly graphs: Readonly<Record<string, string>>;
}

/** `job-scout-workflow` → `jobScoutWorkflow`: the export the graph is read from. */
export const exportNameOf = (workflow: string): string => {
  const camel = workflow.replace(/-([a-z0-9])/g, (_match, next: string) => next.toUpperCase());
  return /^[A-Za-z_$]/.test(camel) ? camel : `_${camel}`;
};

/** The import specifier of the application module from `.agboss/` (ESM: `.js` for a `.ts` file). */
function importSpecifierOf(folder: string, file: string): string {
  const path = relative(folder, file)
    .split(sep)
    .join("/")
    .replace(/\.([cm]?)ts$/, ".$1js");
  return path.startsWith(".") ? path : `./${path}`;
}

/** The name the module exports its `@Application` class under (loaded already: the same module). */
async function exportOf(source: StudioSource): Promise<string> {
  const module = (await import(pathToFileURL(source.file).href)) as Record<string, unknown>;
  const found = Object.entries(module).find(([, value]) => value === source.application);
  if (found === undefined)
    throw new CliError(
      "project",
      "studio.application-export",
      `${source.file}: the @Application class is not exported by name`,
    );
  return found[0];
}

/** The generated module: the application's graphs, one export per workflow. */
export function studioEntryText(
  source: StudioSource,
  applicationExport: string,
  folder: string,
): string {
  const options = source.env === undefined ? "" : `, { env: ${JSON.stringify(source.env)} }`;
  const exports = source.workflows.map(
    (workflow) =>
      `export const ${exportNameOf(workflow)} = studio.graph(${JSON.stringify(workflow)});`,
  );
  return [
    "// Written by `agboss studio` (#268) on every run — not edited, not committed (.agboss/ is",
    "// git-ignored). Every workflow of the application; a child is drawn inside its parent.",
    'import { studioOf } from "agboss/internal";',
    `import { ${applicationExport} } from ${JSON.stringify(importSpecifierOf(folder, source.file))};`,
    "",
    `const studio = await studioOf(${applicationExport}${options});`,
    "",
    ...exports,
    "",
  ].join("\n");
}

/** `langgraph.json`: a graph per workflow, the project's `.env` when it has one. */
export function studioConfigText(
  graphs: Readonly<Record<string, string>>,
  dotEnv: string | undefined,
): string {
  const config = { node_version: "22", graphs, ...(dotEnv === undefined ? {} : { env: dotEnv }) };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Writes `.agboss/studio.ts` and `.agboss/langgraph.json` under the project. */
export async function writeStudioFiles(
  project: string,
  source: StudioSource,
): Promise<StudioFiles> {
  const folder = join(project, STUDIO_FOLDER);
  const entry = join(folder, STUDIO_ENTRY);
  const config = join(folder, STUDIO_CONFIG);
  const graphs = Object.fromEntries(
    source.workflows.map((workflow) => [workflow, `./${STUDIO_ENTRY}:${exportNameOf(workflow)}`]),
  );
  const dotEnv = existsSync(join(project, ".env")) ? "../.env" : undefined;
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, studioEntryText(source, await exportOf(source), folder));
  await writeFile(config, studioConfigText(graphs, dotEnv));
  return { entry, config, graphs };
}
