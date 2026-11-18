import { fileSlotsOf, type FileFetchSlots } from "./a2a-file-slots.js";

/**
 * The application's own slots for fetches of files by url, the default ones (#1312 follow-up): a
 * listener with no `maxConcurrentFileFetches*` option and a model's read of a file by url (#899,
 * which runs with no listener, under `app.execute`, the CLI and a recovery) draw on the same
 * slots, with the same tenant and owner shares, so the sockets they hold are bounded together.
 * Found by the application's file store: every part of one application resolves the same one.
 */
const pools = new WeakMap<object, FileFetchSlots>();

/** The default slots of the application whose file store is `store`: made at the first call. */
export function appFileSlotsOf(store: object): FileFetchSlots {
  const found = pools.get(store);
  if (found !== undefined) return found;
  const made = fileSlotsOf(undefined, undefined);
  pools.set(store, made);
  return made;
}
