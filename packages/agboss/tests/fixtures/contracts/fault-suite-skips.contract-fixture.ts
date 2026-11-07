// #831: what a fault suite leaves out is a skipped case with its reason, and its first case counts
// what runs — tests/faults/suite-registration.test.ts reads the cases. Two scenarios and a sabotage
// selected, the sabotages off, the second of two shards: one scenario runs.
import { faultSuite } from "../../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "../../faults/sqlite-target.js";

faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s01-sigterm-drains", "s02-sigkill-mid-step", "s14-sabotage-every-error-definite"],
  sabotages: false,
  shard: { index: 2, count: 2 },
});
