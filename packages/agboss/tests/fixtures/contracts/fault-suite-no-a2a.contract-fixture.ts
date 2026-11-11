// #811 AC4: a store set that keeps no A2A tasks (the external sets' case) serves no A2A — its A2A
// scenarios are skipped cases with the reason, never passed, never failed;
// tests/faults/suite-registration.test.ts reads the cases.
import { fileURLToPath } from "node:url";
import { faultSuite } from "../../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "../../faults/sqlite-target.js";

faultSuite({
  ...sqliteFaultTarget(
    fileURLToPath(new URL("../../faults/no-a2a.fault-stores.ts", import.meta.url)),
  ),
  name: "SQLite, no A2A tasks",
  scenarios: [
    "s17-a2a-accept-crash",
    "s17b-a2a-id-kept-crash",
    "s18-a2a-resume-vs-cancel",
    "s18b-a2a-cancel-vs-resume",
    "s18c-a2a-resumed-cancel-before-pass",
    "s18d-a2a-drain-took-answer-cancel",
  ],
  sabotages: false,
});
