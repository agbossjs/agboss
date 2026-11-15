/**
 * #1152, on one SQLite file: a resting tree whose cancel died after its durable request is ended as
 * cancelled by the sweep of another instance (the cases are shared with the in-memory run's).
 */
import { beforeEach } from "vitest";
import { testWith } from "../../src/testing/index.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import {
  SqliteRecoveryApplication,
  sqliteFilePerTest,
} from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { cancelRestingCases } from "./cancel-resting-sweep.cases.js";

sqliteFilePerTest();
const test = testWith(SqliteRecoveryApplication, { instances: 2 });

beforeEach(resetRecovery);

cancelRestingCases(test, { hasStampedRecords: false });
