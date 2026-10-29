import { DecidedBy, Judge, JudgeVerdict, type JudgeHandler, type JudgeInput } from "@agboss/core";
import { WorkflowFinishTextDto } from "@agboss/core/dto";

/** What an answer that says where the order is names. */
const WHEREABOUTS = /\b(shipped|archived|delayed|delivered)\b/iu;

/**
 * The desk's eval judge, in code (#396): the finish's answer says where the order is. Its metrics
 * feed `agboss eval calibrate`'s rubric — which measure goes with the judge being wrong.
 */
@Judge({
  name: "desk-answer-judge",
  description: "The answer says where the order is",
  decidedBy: DecidedBy.Code,
  reply: WorkflowFinishTextDto,
})
export class DeskAnswerJudge implements JudgeHandler<WorkflowFinishTextDto> {
  judge({ reply }: JudgeInput<WorkflowFinishTextDto>): Promise<JudgeVerdict> {
    const metrics = { length: reply.text.length, quotesTool: reply.text.startsWith("It says:") };
    return Promise.resolve(
      WHEREABOUTS.test(reply.text)
        ? JudgeVerdict.passed({ metrics })
        : JudgeVerdict.failed({ reason: "the answer does not say where the order is", metrics }),
    );
  }
}
