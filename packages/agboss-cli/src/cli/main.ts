#!/usr/bin/env node
// The project's .env (model keys, env() / secret() values) is read where the application is loaded:
// from the folder of the package.json that holds it (cli-application.ts), never the working directory.
import { runCli } from "./run-cli.js";
import { runWithStar, type StarContext } from "./star.js";

const argv = process.argv.slice(2);

async function dispatch(): Promise<void> {
  process.exitCode = await runCli(argv, {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    stdinIsTTY: process.stdin.isTTY,
  });
  // `run` and `chat` read stdin themselves; for any other command a module of the project that
  // listened to stdin as it was loaded (`agboss check` loads every module of `src/`) must not keep
  // the process alive once the command is done
  if (argv[0] !== "run" && argv[0] !== "chat") {
    process.stdin.pause();
    // only a socket or pipe stdin has unref (a tty ReadStream or a file stream does not)
    const stdin: { unref?: () => unknown } = process.stdin;
    if (typeof stdin.unref === "function") stdin.unref();
  }
}

const star: StarContext = { isTTY: process.stderr.isTTY, env: process.env, argv };
if ((await runWithStar(dispatch, star, process.stderr)) === "threw") process.exitCode = 1;
