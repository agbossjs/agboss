import type { FileFetchPool } from "../../files/file-policy.js";
import { fileSlotsOf, type FileFetchSlots } from "./a2a-file-slots.js";

/**
 * The slots for fetches of files by url (#1312 follow-up, #1316): a policy with no `fetchPool` and
 * every path that reads a file by url — an A2A listener's admission, `Files.read`, a model's read
 * (#899, which runs with no listener, under `app.execute`, the CLI and a recovery) — draw on the
 * application's one default pool, with the same tenant and owner shares, so the sockets they hold
 * are bounded together. A policy that sets a `fetchPool` has a pool of its own, found by the pool
 * object. Found by the application's file store: every part of one application resolves the same one.
 */
const apps = new WeakMap<
  object,
  { shared?: FileFetchSlots; own: WeakMap<object, FileFetchSlots> }
>();

/** The slots of the application whose file store is `store`, for a policy's `fetchPool` (or none). */
export function appFileSlotsOf(store: object, pool?: FileFetchPool): FileFetchSlots {
  let app = apps.get(store);
  if (app === undefined) {
    app = { own: new WeakMap() };
    apps.set(store, app);
  }
  if (pool === undefined) return (app.shared ??= fileSlotsOf(undefined, undefined));
  let own = app.own.get(pool);
  if (own === undefined) {
    own = fileSlotsOf(
      pool.maxConcurrent,
      pool.maxConcurrentPerTenant,
      pool.maxConcurrentPerOwner,
      pool.maxQueuedPerOwner,
    );
    app.own.set(pool, own);
  }
  return own;
}
