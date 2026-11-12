import { describe, expectTypeOf, it } from "vitest";
import {
  type ChannelRoleOptions,
  type PauseAnswerer,
  type PauseAnswerRecord,
  type PendingPause,
} from "../../src/index.js";
import type { ChannelResumeOptions } from "../../src/app/types.js";
import type { ExecutionResumeEvent } from "../../src/core/observability.js";
import type { EvalPauseTrace } from "../../src/eval/index.js";
import type { PauseAnswer, PauseRecord } from "../../src/stores/index.js";

/**
 * #934 AC1: one meaning per name. `answeredBy` is the person who answered (a string); `answerer`
 * is who may answer (`PauseAnswerer`). What is left on the old spelling is a deprecated alias.
 */

describe("AC1: answeredBy is string on every pause type; answerer is PauseAnswerer", () => {
  it("who may answer is `answerer` on the role, the pause record, the pending pause and the log entry", () => {
    expectTypeOf<ChannelRoleOptions["answerer"]>().toEqualTypeOf<PauseAnswerer | undefined>();
    expectTypeOf<PauseRecord["answerer"]>().toEqualTypeOf<PauseAnswerer>();
    expectTypeOf<PendingPause["answerer"]>().toEqualTypeOf<PauseAnswerer>();
    expectTypeOf<PauseAnswerRecord["answerer"]>().toEqualTypeOf<PauseAnswerer>();
  });

  it("who answered is `answeredBy`, a string, where a person is recorded", () => {
    expectTypeOf<PauseAnswer["answeredBy"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PauseAnswerRecord["answeredBy"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<EvalPauseTrace["answeredBy"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChannelResumeOptions["answeredBy"]>().toEqualTypeOf<string>();
    expectTypeOf<ExecutionResumeEvent["answeredBy"]>().toEqualTypeOf<string | undefined>();
  });

  it("the answer of a pause has no `answerer`: it would be the person under the kind's name", () => {
    expectTypeOf<keyof PauseAnswer>().not.toHaveProperty("answerer");
    // @ts-expect-error — 0.1.0's `PauseAnswer.answerer` (the person) is gone, not kept under a wrong meaning
    expectTypeOf<PauseAnswer["answerer"]>().toBeString();
  });
});
