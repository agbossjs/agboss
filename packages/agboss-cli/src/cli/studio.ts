import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { studioOf } from "agboss/internal";
import { loadCliApplication } from "./cli-application.js";
import { requiredText, type CommandContext } from "./context.js";
import { envOption } from "./environment.js";
import { CliError, usageError } from "./errors.js";
import { writeStudioFiles, type StudioFiles } from "./studio-config.js";

/**
 * `agboss studio [--env <name>] [--port N]` (#268 AC7): the application assembled and its
 * environment resolved first — a problem stops it before any server starts — then the Studio
 * config written into `.agboss/` and the LangGraph CLI's dev server started on it.
 */

/** What `agboss studio` serves: the written files and the workflows, by name. */
export interface PreparedStudio extends StudioFiles {
  readonly application: string;
  readonly workflows: readonly string[];
}

/**
 * The application checked as the server will build it — assembled, its `--env` environment
 * resolved, every workflow's graph built, then closed — and its Studio config written: a problem
 * fails here (exit 3), never in the server's log.
 */
export async function prepareStudio(context: CommandContext): Promise<PreparedStudio> {
  const loaded = await loadCliApplication(context);
  const env = envOption(context);
  const studio = await studioOf(loaded.application, { env, processEnv: context.io.env });
  await studio.close();
  const workflows = studio.names;
  const files = await writeStudioFiles(context.io.cwd, {
    file: loaded.path.file,
    application: loaded.application,
    workflows,
    env,
  });
  context.say(`studio: ${relative(context.io.cwd, files.config)} — ${workflows.join(", ")}`);
  return { ...files, application: studio.application, workflows };
}

/** A command line: the program and its arguments. */
export interface CommandLine {
  readonly command: string;
  readonly args: readonly string[];
}

/** The `langgraphjs` script of `@langchain/langgraph-cli`, a dependency of this package. */
function langGraphCliScript(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("@langchain/langgraph-cli/package.json");
  const { bin } = JSON.parse(readFileSync(packageJson, "utf8")) as {
    readonly bin?: Readonly<Record<string, string>>;
  };
  const script = bin?.langgraphjs;
  if (script === undefined)
    throw new CliError(
      "internal",
      "studio.no-langgraph-cli",
      `${packageJson} has no langgraphjs bin`,
    );
  return join(dirname(packageJson), script);
}

/** `--port N`: a whole number from 1 to 65535. */
export function portOf(context: CommandContext): string {
  const port = requiredText(context.values, "port");
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65_535)
    throw usageError(
      context.command,
      "usage.option-value",
      `--port must be 1–65535, got "${port}"`,
    );
  return String(value);
}

/** `langgraphjs dev --config .agboss/langgraph.json --port N`, run by this Node. */
export const langGraphDevOf = (studio: PreparedStudio, port: string): CommandLine => ({
  command: process.execPath,
  args: [langGraphCliScript(), "dev", "--config", studio.config, "--port", port],
});
