import { spawn } from "node:child_process";
import type { CommandHandler, CommandContext } from "./cli/context.js";
import { CliError } from "./cli/errors.js";
import { langGraphDevOf, portOf, prepareStudio, type CommandLine } from "./cli/studio.js";

/**
 * Runs the LangGraph dev server until it exits: a SIGINT / SIGTERM of this process is passed on to
 * it, and this process waits for it rather than exiting first; its exit code (0 when stopped).
 * Under `--json` its output goes to stderr: stdout carries only the envelope.
 */
function serve(context: CommandContext, line: CommandLine): Promise<number> {
  const server = spawn(line.command, line.args, {
    cwd: context.io.cwd,
    env: context.io.env,
    stdio: ["inherit", context.json ? 2 : 1, 2],
  });
  let isStopped = false;
  const passOn = (signal: NodeJS.Signals): void => {
    isStopped = true;
    server.kill(signal);
  };
  process.on("SIGINT", passOn);
  process.on("SIGTERM", passOn);
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    // stopped by a signal (Ctrl+C, SIGTERM) is the normal end, whatever code the server exits with
    server.once("exit", (code, signal) => {
      resolve(isStopped || signal !== null ? 0 : (code ?? 0));
    });
  }).finally(() => {
    process.off("SIGINT", passOn);
    process.off("SIGTERM", passOn);
  });
}

/**
 * `agboss studio [--env <name>] [--port N] [--application <path>]` (#268 AC7) — no `studio.ts`, no
 * `langgraph.json` in the project: every workflow of the application in LangGraph Studio, a child
 * drawn inside its parent.
 */
export const handle: CommandHandler = async (context) => {
  const port = portOf(context);
  const studio = await prepareStudio(context);
  const code = await serve(context, langGraphDevOf(studio, port));
  const result = { application: studio.application, config: studio.config, graphs: studio.graphs };
  if (code === 0) return { result };
  const failure = new CliError(
    "internal",
    "studio.server",
    `the Studio server exited with ${String(code)}`,
  );
  return { result, failure };
};
