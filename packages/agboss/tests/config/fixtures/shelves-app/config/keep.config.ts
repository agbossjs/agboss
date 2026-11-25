import { defineConfig } from "../../../../../src/index.js";
import { hours, minutes } from "../../../../../src/units/index.js";

/** Rows kept an hour, the mesh forgetting answers after thirty minutes and passing three hops. */
export default defineConfig({
  databaseStorages: {
    "shelf-database-storage": { auditLogTtl: hours(1), ledgerEntriesTtl: hours(2) },
  },
  mesh: { "shelf-mesh": { deduplicationTtl: minutes(30), maxHops: 3 } },
});
