/**
 * #1152, in memory: a resting tree whose cancel died after its durable request is ended as cancelled
 * by the sweep of another instance (the cases are shared with the SQLite file's).
 */
import { beforeEach, describe } from "vitest";
import { testWith } from "../../src/testing/index.js";
import {
  RecoveryApplication,
  resetRecovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { cancelRestingCases } from "./cancel-resting-sweep.cases.js";

const test = testWith(RecoveryApplication, { instances: 2 });

beforeEach(resetRecovery);

// 0.1 s a case alone, 6.6 s once in a loaded run (3 workers, two busy loops) against vitest's 5 s default (#1219): the bound says "not hung"
describe("cancel-resting sweep", { timeout: 60_000 }, () => {
  cancelRestingCases(test, { hasStampedRecords: true });
});
