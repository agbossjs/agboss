import type { BuiltApp } from "../app/create-app.js";
import { startComponents } from "../components/container/lifecycle.js";

/**
 * `onInit` → `onStart` of every component, then each workflow's config snapshot (#747): the stores
 * are ready only now — a PostgreSQL schema is checked or migrated at its connection's `onInit`.
 */
export async function startAll(created: unknown[], workflows: readonly BuiltApp[]): Promise<void> {
  await startComponents(created);
  for (const workflow of workflows) await workflow.deps.rememberConfig();
}

/** Closes what the workflows already built opened (a later workflow or a start hook failed). */
export async function releaseAll(built: readonly BuiltApp[]): Promise<void> {
  for (const workflow of built) await workflow.app.close();
}
