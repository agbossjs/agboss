import { defineConfig } from "../../../../../src/index.js";

export default defineConfig({
  modelProvider: class NoProvider {
    readonly kind = "no-provider";
  },
});
