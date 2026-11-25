import { defineConfig } from "../../../../../src/index.js";
import { FilesBareWorkflow } from "../files.application.js";

export default defineConfig({
  workflows: { "files-bare-workflow": { filePolicy: FilesBareWorkflow } },
});
