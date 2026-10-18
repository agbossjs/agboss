#!/usr/bin/env node
// Every command reads the project's .env (model keys, env() / secret() values) — once, here.
import "dotenv/config";
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
}

const star: StarContext = { isTTY: process.stderr.isTTY, env: process.env, argv };
if ((await runWithStar(dispatch, star, process.stderr)) === "threw") process.exitCode = 1;
