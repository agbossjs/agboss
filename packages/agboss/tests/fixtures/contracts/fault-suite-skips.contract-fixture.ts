// #831: what a fault suite leaves out is a skipped case with its reason, and its first case counts
// what runs — tests/faults/suite-registration.test.ts reads the cases. One shard of a selection of
// one: nothing but the atomic-fencing case starts a pod.
import { faultSuite } from "../../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "../../faults/sqlite-target.js";

faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s01-sigterm-drains"],
  shard: { index: 2, count: 2 },
});
faultSuite({
  ...sqliteFaultTarget(),
  name: "SQLite, no sabotages",
  scenarios: ["s14-sabotage-every-error-definite"],
  sabotages: false,
});
