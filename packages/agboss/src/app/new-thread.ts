import type { NewThreadAccess, ThreadAccess } from "../run/thread.js";
import type { AppDeps } from "./app-deps.js";

/**
 * A new thread — the caller's own id, or one made now; two creating one id: the first owns it
 * (`owned` checks the owner of the id the caller named).
 */
export const newThreadOf =
  (deps: Pick<AppDeps, "turns" | "config">, owned: (access: ThreadAccess) => Promise<void>) =>
  async (access: NewThreadAccess): Promise<string> => {
    const { tenantId, threadId, ownerId } = access;
    const id = await deps.turns.createThread({ workflow: deps.config.name, ...access });
    if (threadId !== undefined) await owned({ tenantId, threadId: id, ownerId });
    return id;
  };
