/**
 * #928 AC2 sabotages S2a and S2b — the framework's rule (a call of unknown outcome is neither done
 * nor not done) broken on purpose, on SQLite pods, as the suite runs them on every set: each case
 * passes only when `effects-once` fails with its evidence.
 * - S2a: a payment that takes a timed-out `markCompleted` for a definite failure sends again, never
 *   reconciles — two gateway charges;
 * - S2b: a fenced-effect store that answers `Ran` for a write that never answered — under the
 *   framework's bound — lets the step finish past a charge nobody made.
 */
import { expect, it } from "vitest";
import { sabotaged } from "../../src/testing/faults/fault-suite.js";
import {
  s22UnknownAsDone,
  s22UnknownAsNotSent,
} from "../../src/testing/faults/scenarios/s22-sabotages.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

it("S2a: a timed-out markCompleted taken for not sent — sent again, two gateway charges", async () => {
  await expect(
    sabotaged(s22UnknownAsNotSent, sqliteFaultTarget(), expect),
  ).resolves.toBeUndefined();
}, 120_000);

it("S2b: a timed-out fenced write answered Ran — the tree finishes with no business row", async () => {
  await expect(sabotaged(s22UnknownAsDone, sqliteFaultTarget(), expect)).resolves.toBeUndefined();
}, 120_000);
