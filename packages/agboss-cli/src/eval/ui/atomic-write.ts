import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A file written whole (#397 PR 4–5): to a temporary file beside it, then renamed over it — a
 * reader (an editor, `agboss check`, a test run) never sees half of it.
 */
export function writeAtomically(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, file);
}
