import type { JudgeVerdict } from "../../components/judge-decorators.js";
import { bareRecordOf, ComponentKind } from "../../flow/runtime/records.js";
import type { JudgeVerdictRecord } from "../../flow/runtime/step-records.js";

/** A verdict as the step's record keeps it (#395 C3). */
export const verdictRecordOf = (
  judge: string,
  attempt: number,
  verdict: JudgeVerdict,
): JudgeVerdictRecord => ({
  judge: bareRecordOf(judge, ComponentKind.Judge),
  attempt,
  passed: verdict.passed,
  ...(verdict.passed ? {} : { reason: verdict.reason }),
  ...(verdict.metrics === undefined ? {} : { metrics: verdict.metrics }),
});
