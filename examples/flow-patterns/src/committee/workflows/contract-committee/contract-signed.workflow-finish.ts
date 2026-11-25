import { WorkflowFinish } from "@agboss/core";
import { SignedContractDto } from "../../dto/signed-contract.dto.js";

/** Where a committee finishes with its quorum: the signed contract. */
@WorkflowFinish({
  name: "contract-signed-workflow-finish",
  description: "The contract, signed on the committee's approvals",
  output: SignedContractDto,
})
export class ContractSignedWorkflowFinish {}
