import { startComponents } from "../components/container/lifecycle.js";
import { releaseOf } from "./app-deps-parts.js";

/** A workflow on its own starts its components itself: a failing hook releases MCP and tracing. */
async function startOwnComponents(
  created: unknown[],
  ...resources: Parameters<typeof releaseOf>
): Promise<void> {
  await startComponents(created).catch(async (error: unknown) => {
    await releaseOf(...resources)();
    throw error;
  });
}

/** A workflow on its own starts its components, then writes its config snapshot. */
export async function startedOwn(
  isOwn: boolean,
  created: unknown[],
  resources: Parameters<typeof releaseOf>,
  snapshot: { readonly rememberConfig: () => Promise<void> },
): Promise<void> {
  if (!isOwn) return;
  await startOwnComponents(created, ...resources);
  await snapshot.rememberConfig();
}
