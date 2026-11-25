import { describe, expectTypeOf, it } from "vitest";
import {
  type ToolApprovalOptions,
  type PauseRespondent,
  type PauseAnswerRecord,
  type PauseActor,
  type PendingPause,
} from "../../src/index.js";
import type { DelegateResumeOptions } from "../../src/app/types.js";
import type { ExecutionResumeEvent } from "../../src/core/observability.js";
import type { EvalPauseTrace } from "../../src/eval/index.js";
import type { PauseAnswer, PauseRecord } from "../../src/stores/index.js";

/**
 * #934 AC1: one meaning per name. `actor` is who answered (a `PauseActor`); `respondent`
 * is who may answer (`PauseRespondent`). What is left on the old spelling is a deprecated alias.
 */

describe("AC1: actor is a PauseActor on every pause type; respondent is PauseRespondent", () => {
  it("who may answer is `respondent` on the target, the pause record, the pending pause and the log entry", () => {
    expectTypeOf<ToolApprovalOptions["respondent"]>().toEqualTypeOf<PauseRespondent>();
    expectTypeOf<PauseRecord["respondent"]>().toEqualTypeOf<PauseRespondent>();
    expectTypeOf<PendingPause["respondent"]>().toEqualTypeOf<PauseRespondent>();
    expectTypeOf<PauseAnswerRecord["respondent"]>().toEqualTypeOf<PauseRespondent>();
  });

  it("who answered is `actor`, a `PauseActor`, where a person or a system is recorded", () => {
    expectTypeOf<PauseAnswer["actor"]>().toEqualTypeOf<PauseActor | undefined>();
    expectTypeOf<PauseAnswerRecord["actor"]>().toEqualTypeOf<PauseActor | undefined>();
    expectTypeOf<EvalPauseTrace["actor"]>().toEqualTypeOf<PauseActor | undefined>();
    expectTypeOf<DelegateResumeOptions["actor"]>().toEqualTypeOf<PauseActor>();
    expectTypeOf<ExecutionResumeEvent["actor"]>().toEqualTypeOf<PauseActor | undefined>();
  });

  it("0.1.0's `answeredBy` is gone from every pause type", () => {
    expectTypeOf<PauseAnswer>().not.toHaveProperty("answeredBy");
    expectTypeOf<PauseAnswerRecord>().not.toHaveProperty("answeredBy");
    expectTypeOf<DelegateResumeOptions>().not.toHaveProperty("answeredBy");
    expectTypeOf<ExecutionResumeEvent>().not.toHaveProperty("answeredBy");
    expectTypeOf<PauseAnswer>().not.toHaveProperty("byChannel");
  });

  it("the answer of a pause has no `respondent`: it would be the person under the kind's name", () => {
    expectTypeOf<keyof PauseAnswer>().not.toHaveProperty("respondent");
    // @ts-expect-error — 0.1.0's `PauseAnswer.respondent` (the person) is gone, not kept under a wrong meaning
    expectTypeOf<PauseAnswer["respondent"]>().toBeString();
  });
});
