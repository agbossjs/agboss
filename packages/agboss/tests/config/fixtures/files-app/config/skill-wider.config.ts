import { defineConfig } from "../../../../../src/index.js";
import { bytes } from "../../../../../src/units/index.js";

/** The skill's policy made wider than its workflow's: the rule reads the profile's values. */
export default defineConfig({
  filePolicies: {
    "file-review-policy": { maxFileSize: bytes(20) },
    "files-skill-policy": { maxFileSize: bytes(30) },
  },
});
