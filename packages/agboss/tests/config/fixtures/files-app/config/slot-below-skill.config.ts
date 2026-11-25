import { defineConfig } from "../../../../../src/index.js";
import { kilobytes } from "../../../../../src/units/index.js";
import { FilesSlotPolicy } from "../files.application.js";

/** The slot's policy made smaller than the skill's own (4 KB): the skill would widen it. */
export default defineConfig({
  filePolicies: { "files-slot-policy": { maxFileSize: kilobytes(1) } },
  workflows: { "file-summary-workflow": { filePolicy: FilesSlotPolicy } },
});
