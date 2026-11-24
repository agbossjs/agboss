import type { Milliseconds } from "../../units/index.js";
import { FileRepository } from "../../infrastructure/file.repository.js";
import type { A2AApp } from "../a2a-caller.js";
import type { A2AServerFiles } from "../server/a2a-server-parts.js";
import { DEFAULT_FILE_FETCH_TIMEOUT } from "./a2a-file-options.js";
import { fileFetchesOf, fileTransportOf } from "./a2a-file-seam.js";
import { appFileSlotsOf } from "./a2a-file-pool.js";
import { fileSlotsOf, type FileFetchSlots } from "./a2a-file-slots.js";

/** The listener options that bound a file's fetch. */
interface FileFetchOptions {
  readonly fileFetchTimeout?: Milliseconds;
  readonly maxConcurrentFileFetches?: number;
  readonly maxConcurrentFileFetchesPerTenant?: number;
  readonly maxConcurrentFileFetchesPerOwner?: number;
}

/** Slots of the listener's own when it is given a limit; else the application's, shared with a model's reads (#1312). */
const slotsOf = (store: object, options: FileFetchOptions): FileFetchSlots =>
  options.maxConcurrentFileFetches === undefined &&
  options.maxConcurrentFileFetchesPerTenant === undefined &&
  options.maxConcurrentFileFetchesPerOwner === undefined
    ? appFileSlotsOf(store)
    : fileSlotsOf(
        options.maxConcurrentFileFetches,
        options.maxConcurrentFileFetchesPerTenant,
        options.maxConcurrentFileFetchesPerOwner,
      );

/** Where the listener's files are kept and how one by url is fetched (#859): bound by time (#859) and by slots (#1256). */
export const serverFilesOf = (app: A2AApp, options: FileFetchOptions): A2AServerFiles => {
  const store = app.resolve(FileRepository);
  return {
    store,
    transport: fileTransportOf(options),
    timeout: options.fileFetchTimeout ?? DEFAULT_FILE_FETCH_TIMEOUT,
    fetches: fileFetchesOf(options),
    slots: slotsOf(store, options),
  };
};
