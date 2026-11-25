import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileOwner, FileOwnerCompletion } from "./file.repository.js";
import { parsedStoredJson } from "./stored-step.js";

/** The folder of the owners' completion marks: not a tenant's. */
export const COMPLETED_OWNERS = "completed-owners";

/** A completion as kept on disk: its time as ISO 8601. */
export type StoredCompletion = Omit<FileOwnerCompletion, "completedAt"> & {
  readonly completedAt: string;
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";

/** The owners of a store folder whose execution ended. */
export async function completionsIn(folder: string): Promise<readonly FileOwnerCompletion[]> {
  const dir = join(folder, COMPLETED_OWNERS);
  const names = await readdir(dir).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  const found: FileOwnerCompletion[] = [];
  for (const name of names) {
    const text = await readFile(join(dir, name), "utf8");
    const stored = parsedStoredJson({ what: "file completion", text }) as StoredCompletion;
    found.push({ ...stored, completedAt: new Date(stored.completedAt) });
  }
  return found;
}

const nameOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The file of an owner's completion in a store folder: no id reaches a path. */
export const completionPathOf = (folder: string, owner: FileOwner): string =>
  join(folder, COMPLETED_OWNERS, `${nameOf(owner.tenantId)}.${nameOf(owner.ownerId)}.json`);
