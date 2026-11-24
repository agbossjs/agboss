/**
 * #1307d type pins: 0.1.0's aliases are gone from the pause shapes — `answeredBy` beside `answerer` on a
 * pending pause, a pause record and a described channel, `responder` beside `answeredBy` (the person) on an
 * answer record.
 */
import { expectTypeOf, test } from "vitest";
import type { DescribedChannel } from "../../src/describe/channels.js";
import type { PauseAnswerRecord } from "../../src/flow/runtime/execution-record.js";
import type { PauseRecord } from "../../src/infrastructure/pause-record.js";
import type { PendingPauseBase } from "../../src/pause/index.js";

test("no pause shape names a 0.1.0 alias", () => {
  expectTypeOf<PendingPauseBase>().not.toHaveProperty("answeredBy");
  expectTypeOf<PendingPauseBase>().toHaveProperty("answerer");
  expectTypeOf<PauseRecord>().not.toHaveProperty("answeredBy");
  expectTypeOf<DescribedChannel>().not.toHaveProperty("answeredBy");
  expectTypeOf<PauseAnswerRecord>().not.toHaveProperty("responder");
  expectTypeOf<PauseAnswerRecord>().not.toHaveProperty("answeredBy");
  expectTypeOf<PauseAnswerRecord>().toHaveProperty("actor");
});
