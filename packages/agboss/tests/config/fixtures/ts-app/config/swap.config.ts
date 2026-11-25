import { defineConfig } from "../../../../../src/index.js";
import { OtherModels } from "../ts.application.js";

/** The application's provider replaced whole; the workflow's own provider for one workflow. */
export default defineConfig({ modelProvider: OtherModels });
