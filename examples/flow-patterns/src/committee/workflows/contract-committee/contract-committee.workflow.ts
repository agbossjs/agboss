import {
  onStart,
  QuorumNotReachedError,
  toExternalTask,
  toFinish,
  Workflow,
  Ttl,
} from "@agboss/core";
import { hours } from "@agboss/core/units";
import { SignContractAction } from "../../actions/sign-contract.action.js";
import { SignOffArbiter } from "../../arbiters/sign-off/sign-off.arbiter.js";
import { FinanceDirectorSignOffExternalTask } from "../../external-tasks/finance-director-sign-off.external-task.js";
import { LegalSignOffExternalTask } from "../../external-tasks/legal-sign-off.external-task.js";
import { SecuritySignOffExternalTask } from "../../external-tasks/security-sign-off.external-task.js";
import { CommitteeDeskService } from "../../services/committee-desk.service.js";
import { ContractCommitteeWorkflowStart } from "./contract-committee.workflow-start.js";
import { ContractRejectedWorkflowFinish } from "./contract-rejected.workflow-finish.js";
import { ContractSignedWorkflowFinish } from "./contract-signed.workflow-finish.js";

/**
 * A committee of external parties (#1306): legal, security and the finance director are asked at
 * once, each through its own pause and channel, with no agent wrapped around them. Two approvals of
 * three are enough — the arbiter counts only an approval —, the third pause is withdrawn once the
 * quorum is met, and no quorum in time sends the contract back.
 */
@Workflow({
  name: "contract-committee-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ContractCommitteeWorkflowStart)
      .inParallel([
        toExternalTask(LegalSignOffExternalTask),
        toExternalTask(SecuritySignOffExternalTask),
        toExternalTask(FinanceDirectorSignOffExternalTask),
      ])
      .arbitratedBy(SignOffArbiter)
      .joinQuorum({ min: 2, deadline: hours(2) })
      .onError(QuorumNotReachedError, toFinish(ContractRejectedWorkflowFinish))
      .toAction(SignContractAction)
      .toFinish(ContractSignedWorkflowFinish),
  ],
  providers: [CommitteeDeskService],
})
export class ContractCommitteeWorkflow {}
