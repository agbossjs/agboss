import { defineConfig } from "../../../../../src/index.js";
import { FilesSlotPolicy } from "../files.application.js";

/** The summary workflow's files are bounded by another policy. */
export default defineConfig({
  workflows: { "file-summary-workflow": { filePolicy: FilesSlotPolicy } },
});
