/**
 * #1152, in memory: a resting tree whose cancel died after its durable request is ended as cancelled
 * by the sweep of another instance (the cases are shared with the SQLite file's).
 */
import { beforeEach } from "vitest";
import { testWith } from "../../src/testing/index.js";
import {
  RecoveryApplication,
  resetRecovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { cancelRestingCases } from "./cancel-resting-sweep.cases.js";

const test = testWith(RecoveryApplication, { instances: 2 });

beforeEach(resetRecovery);

cancelRestingCases(test, { hasStampedRecords: true });
