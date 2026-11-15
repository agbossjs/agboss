import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #1098 — scenarios 27a and 27b: an answered question's writes saved, the checkpoint after them
 * never answers, the holder killed; an own-thread child's (27a) and the second of two in a row
 * whose resume waits on another pod (27b). The next holder moves the tree on, once. SQLite pods.
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s27a-child-answer-saved-put-held", "s27b-second-answer-saved-resume-waits"],
});
