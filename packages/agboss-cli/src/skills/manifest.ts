import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SkillFile } from "./source.js";

/**
 * The manifest of a project's skills folder (#305): `.agboss-skills.json` — the `agboss` version
 * the files were written for and the sha256 of each, so `agboss check` tells an upgrade, a missing
 * file and a hand edit apart without the source at hand.
 */

/** The manifest's file name inside the skills folder. */
export const MANIFEST_FILE = ".agboss-skills.json";

/** `sha256-<hex>` of a file, by its path inside the skills folder. */
export type SkillFileHashes = Readonly<Record<string, string>>;

/** What `.agboss-skills.json` holds. */
export interface SkillsManifest {
  readonly version: string;
  readonly files: SkillFileHashes;
}

const ManifestSchema = z.object({
  version: z.string().min(1),
  files: z.record(z.string(), z.string()),
});

/** `sha256-<hex>` of a text. */
export const hashOf = (content: string): string =>
  `sha256-${createHash("sha256").update(content).digest("hex")}`;

/** The manifest of `files`, written for `version`. */
export const manifestOf = (version: string, files: readonly SkillFile[]): SkillsManifest => ({
  version,
  files: Object.fromEntries(files.map((file) => [file.path, hashOf(file.content)])),
});

/** The manifest as it is written: JSON, two-space indents, a final newline. */
export const manifestText = (manifest: SkillsManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

/** The folder's manifest; undefined when it is missing or not a manifest (then nothing is managed). */
export function readManifest(folder: string): SkillsManifest | undefined {
  const file = join(folder, MANIFEST_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
