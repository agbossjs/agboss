import { defineConfig } from "../../../../../src/index.js";
import { FilesSlotPolicy } from "../files.application.js";

/** The one policy a workflow that declares none gets. */
export default defineConfig({
  workflows: { "files-bare-workflow": { filePolicy: FilesSlotPolicy } },
});
