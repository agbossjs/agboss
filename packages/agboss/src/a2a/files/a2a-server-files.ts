import { FileRepository } from "../../infrastructure/file.repository.js";
import type { A2AApp } from "../a2a-caller.js";
import type { A2AServerFiles } from "../server/a2a-server-parts.js";
import { fileFetchesOf, fileTransportOf } from "./a2a-file-seam.js";
import { appFileSlotsOf } from "./a2a-file-pool.js";

/**
 * Where the listener's files are kept and how one by url is fetched (#859): bound by time and by
 * slots (#1256) as each skill's `@FilePolicy` says (`fetchTimeout`, `fetchPool`, #1316).
 */
export const serverFilesOf = (app: A2AApp, options: object): A2AServerFiles => {
  const store = app.resolve(FileRepository);
  return {
    store,
    transport: fileTransportOf(options),
    fetches: fileFetchesOf(options),
    slotsOf: (limits) => appFileSlotsOf(store, limits.fetchPool),
  };
};
