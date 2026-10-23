import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CommandContext } from "../cli/context.js";

/** Writes a file the command makes (its folders created); the path as given, relative to the working directory. */
export function writeOutputFile(context: CommandContext, path: string, text: string): void {
  const file = resolve(context.io.cwd, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
