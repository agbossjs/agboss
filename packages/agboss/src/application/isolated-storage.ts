import type { Class } from "../components/injection.js";
import { lazyLoad } from "../infrastructure/clock.js";
import { declaredOf, isFunction } from "../storage/storage-assembly.js";
import type { ApplicationOptions } from "./application.js";
import { isolatedChildrenOf } from "./isolated-worker-rules.js";

/**
 * `ChildPlacement.IsolatedWorker` with in-memory storage (#1286b, D9): a forked process reaches the
 * stores only through a database the processes share, so an application with no `storage`, or with
 * `InMemoryDatabaseStorage`, and an isolated child gets a temporary SQLite file in place of it —
 * shared with its forks and removed when the process ends. A database the application chose is
 * never replaced.
 */

/** The file's storage of each application (its `workflows` list): every instance and every pass over the options shares it. */
const made = new WeakMap<object, Class>();

/** The options as written, with the temporary file where the built-in in-memory database would be. */
export async function withIsolatedStorage(
  options: ApplicationOptions,
): Promise<ApplicationOptions> {
  if (isolatedChildrenOf(options).length === 0) return options;
  const storages = await lazyLoad(import("../storage/in-memory-storage.js"));
  const { database: chosen } = declaredOf(options.storage);
  if (chosen !== undefined && chosen !== storages.InMemoryDatabaseStorage) return options;
  const database = made.get(options.workflows) ?? storages.temporaryFileDatabaseStorage();
  made.set(options.workflows, database);
  const { storage } = options;
  return {
    ...options,
    storage: storage === undefined || isFunction(storage) ? database : { ...storage, database },
  };
}
