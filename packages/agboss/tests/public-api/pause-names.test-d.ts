import { describe, expectTypeOf, it } from "vitest";
import {
  type ChannelRoleOptions,
  type PauseAnswerer,
  type PauseAnswerRecord,
  type PauseActor,
  type PendingPause,
} from "../../src/index.js";
import type { ChannelResumeOptions } from "../../src/app/types.js";
import type { ExecutionResumeEvent } from "../../src/core/observability.js";
import type { EvalPauseTrace } from "../../src/eval/index.js";
import type { PauseAnswer, PauseRecord } from "../../src/stores/index.js";

/**
 * #934 AC1: one meaning per name. `actor` is who answered (a `PauseActor`); `answerer`
 * is who may answer (`PauseAnswerer`). What is left on the old spelling is a deprecated alias.
 */

describe("AC1: actor is a PauseActor on every pause type; answerer is PauseAnswerer", () => {
  it("who may answer is `answerer` on the role, the pause record, the pending pause and the log entry", () => {
    expectTypeOf<ChannelRoleOptions["answerer"]>().toEqualTypeOf<PauseAnswerer>();
    expectTypeOf<PauseRecord["answerer"]>().toEqualTypeOf<PauseAnswerer>();
    expectTypeOf<PendingPause["answerer"]>().toEqualTypeOf<PauseAnswerer>();
    expectTypeOf<PauseAnswerRecord["answerer"]>().toEqualTypeOf<PauseAnswerer>();
  });

  it("who answered is `actor`, a `PauseActor`, where a person or a system is recorded", () => {
    expectTypeOf<PauseAnswer["actor"]>().toEqualTypeOf<PauseActor | undefined>();
    expectTypeOf<PauseAnswerRecord["actor"]>().toEqualTypeOf<PauseActor | undefined>();
    expectTypeOf<EvalPauseTrace["actor"]>().toEqualTypeOf<PauseActor | undefined>();
    expectTypeOf<ChannelResumeOptions["actor"]>().toEqualTypeOf<PauseActor>();
    expectTypeOf<ExecutionResumeEvent["actor"]>().toEqualTypeOf<PauseActor | undefined>();
  });

  it("0.1.0's `answeredBy` is gone from every pause type", () => {
    expectTypeOf<PauseAnswer>().not.toHaveProperty("answeredBy");
    expectTypeOf<PauseAnswerRecord>().not.toHaveProperty("answeredBy");
    expectTypeOf<ChannelResumeOptions>().not.toHaveProperty("answeredBy");
    expectTypeOf<ExecutionResumeEvent>().not.toHaveProperty("answeredBy");
    expectTypeOf<PauseAnswer>().not.toHaveProperty("byChannel");
  });

  it("the answer of a pause has no `answerer`: it would be the person under the kind's name", () => {
    expectTypeOf<keyof PauseAnswer>().not.toHaveProperty("answerer");
    // @ts-expect-error — 0.1.0's `PauseAnswer.answerer` (the person) is gone, not kept under a wrong meaning
    expectTypeOf<PauseAnswer["answerer"]>().toBeString();
  });
});
