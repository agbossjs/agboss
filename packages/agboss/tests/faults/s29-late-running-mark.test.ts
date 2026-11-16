import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #1179 — scenario 29 — a resume's late `running` mark: b records its answer and its call stops
 * before it takes the tree's lease; a's sweep takes the answer and rests the tree at its second
 * question; b's call goes on. The record of a tree that rests at an open pause says `paused`, never
 * the `running` of a mark made for the rest before. On SQLite pods.
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: [
    "s29-late-running-mark-on-a-rest",
    "s29b-late-running-mark-pod-killed",
    "s29c-killed-after-mark-and-answer-before-lease",
    "s29d-killed-after-mark-before-answer",
  ],
});
