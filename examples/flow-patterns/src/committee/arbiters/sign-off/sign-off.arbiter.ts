import { Arbiter, Arbitrate, type ArbitratedAnswerOf } from "@agboss/core";
import { FinanceDirectorSignOffExternalTask } from "../../external-tasks/finance-director-sign-off.external-task.js";
import { LegalSignOffExternalTask } from "../../external-tasks/legal-sign-off.external-task.js";
import { SecuritySignOffExternalTask } from "../../external-tasks/security-sign-off.external-task.js";

type SignOffAnswer = ArbitratedAnswerOf<
  [
    typeof LegalSignOffExternalTask,
    typeof SecuritySignOffExternalTask,
    typeof FinanceDirectorSignOffExternalTask,
  ]
>;

/**
 * Counts only an approval (#1283, #1306): a refusal is a valid answer — the pause is answered — but
 * no vote for the contract, so two refusals leave the quorum out of reach and it fails at once.
 */
@Arbiter({ name: "sign-off-arbiter" })
export class SignOffArbiter {
  @Arbitrate(
    LegalSignOffExternalTask,
    SecuritySignOffExternalTask,
    FinanceDirectorSignOffExternalTask,
  )
  isApproved(answer: SignOffAnswer): boolean {
    return answer.approved;
  }
}
