import type { Milliseconds } from "../../units/index.js";
import { A2AFileRepository } from "../../infrastructure/a2a-file.repository.js";
import type { A2AApp } from "../a2a-caller.js";
import type { A2AServerFiles } from "../server/a2a-server-parts.js";
import { DEFAULT_FILE_FETCH_TIMEOUT } from "./a2a-file-options.js";
import { fileFetchesOf, fileTransportOf } from "./a2a-file-seam.js";
import { fileSlotsOf } from "./a2a-file-slots.js";

/** The listener options that bound a file's fetch. */
interface FileFetchOptions {
  readonly fileFetchTimeout?: Milliseconds;
  readonly maxConcurrentFileFetches?: number;
  readonly maxConcurrentFileFetchesPerTenant?: number;
}

/** Where the listener's files are kept and how one by url is fetched (#859): bound by time (#859) and by slots (#1256). */
export const serverFilesOf = (app: A2AApp, options: FileFetchOptions): A2AServerFiles => ({
  store: app.resolve(A2AFileRepository),
  transport: fileTransportOf(options),
  timeout: options.fileFetchTimeout ?? DEFAULT_FILE_FETCH_TIMEOUT,
  fetches: fileFetchesOf(options),
  slots: fileSlotsOf(options.maxConcurrentFileFetches, options.maxConcurrentFileFetchesPerTenant),
});
