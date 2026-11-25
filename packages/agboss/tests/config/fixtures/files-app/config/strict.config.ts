import { defineConfig } from "../../../../../src/index.js";
import { bytes, hours, seconds } from "../../../../../src/units/index.js";

/** The review workflow's files: two hours, 20 bytes each, one text file; the skill's own policy 10 bytes. */
export default defineConfig({
  filePolicies: {
    "file-review-policy": {
      ttl: hours(2),
      maxFileSize: bytes(20),
      maxTotalFileSize: bytes(40),
      maxFiles: 1,
      allowedMediaTypes: ["text/plain"],
      fetchTimeout: seconds(2),
    },
    "files-skill-policy": { maxFileSize: bytes(10) },
    "files-agent-policy": { maxFileSize: bytes(15), fetchTimeout: seconds(3) },
  },
});
