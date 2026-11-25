import { WorkflowFinish } from "@agboss/core";
import { ContractDto } from "../../dto/contract.dto.js";

/** Where a committee finishes without a quorum: the contract, back to its author. */
@WorkflowFinish({
  name: "contract-rejected-workflow-finish",
  description: "The contract, back to its author: the committee did not agree",
  output: ContractDto,
})
export class ContractRejectedWorkflowFinish {}
