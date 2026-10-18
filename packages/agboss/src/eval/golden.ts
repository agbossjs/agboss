import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { TernRecords } from "../terns/index.js";

/** A saved set of tasks for reproducible comparisons: `golden/<workflow>/<name>.yaml`. */
export const GoldenSetSchema = z.strictObject({
  name: z.string().min(1),
  bundle: z.string().min(1),
  created: z.string(),
  tasks: z.array(z.strictObject({ task: z.string().min(1), note: z.string().optional() })).min(1),
});

export type GoldenSet = z.infer<typeof GoldenSetSchema>;

export class GoldenSetError extends Error {
  override name = "GoldenSetError";
}

export const goldenFile = (root: string, bundle: string, name: string): string =>
  join(root, "golden", bundle, `${name}.yaml`);

export async function loadGolden(file: string): Promise<GoldenSet> {
  const parsed = GoldenSetSchema.safeParse(parseYaml(await readFile(file, "utf8")));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new GoldenSetError(
      `${file}: ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

export async function saveGolden(file: string, set: GoldenSet): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(GoldenSetSchema.parse(set)));
}

/** The last `limit` distinct real tasks of a workflow (answered, not replays), oldest first. */
export async function goldenFromRecent(
  terns: TernRecords,
  bundle: string,
  name: string,
  limit: number,
  now: () => Date = () => new Date(),
): Promise<GoldenSet> {
  const recent = await terns.recentOriginals(bundle, limit);
  const tasks = [...new Set(recent.map((tern) => tern.task))].map((task) => ({ task }));
  if (tasks.length === 0) throw new GoldenSetError(`No answered tasks of "${bundle}" to save`);
  return { name, bundle, created: now().toISOString(), tasks };
}
