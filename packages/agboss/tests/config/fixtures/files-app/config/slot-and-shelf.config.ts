import { defineConfig } from "../../../../../src/index.js";
import { hours } from "../../../../../src/units/index.js";
import { FilesSlotPolicy } from "../files.application.js";

/** The summary workflow's files under another policy, and that policy's ttl changed in its turn. */
export default defineConfig({
  filePolicies: { "files-slot-policy": { ttl: hours(3) } },
  workflows: { "file-summary-workflow": { filePolicy: FilesSlotPolicy } },
});
