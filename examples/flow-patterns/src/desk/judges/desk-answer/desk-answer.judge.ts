import { Judge, JudgeVerdict, type JudgeInput } from "@agboss/core";
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
  output: WorkflowFinishTextDto,
})
export class DeskAnswerJudge {
  judge({ output }: JudgeInput<WorkflowFinishTextDto>): JudgeVerdict {
    const metrics = { length: output.text.length, quotesTool: output.text.startsWith("It says:") };
    return WHEREABOUTS.test(output.text)
      ? JudgeVerdict.passed({ metrics })
      : JudgeVerdict.failed("the answer does not say where the order is", { metrics });
  }
}
