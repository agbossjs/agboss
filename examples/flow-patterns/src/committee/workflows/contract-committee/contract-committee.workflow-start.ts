import { WorkflowStart } from "@agboss/core";
import { ContractDto } from "../../dto/contract.dto.js";

/** Where a committee starts: the contract to sign off. */
@WorkflowStart({
  name: "contract-committee-workflow-start",
  description: "A contract for the committee to sign off",
  input: ContractDto,
})
export class ContractCommitteeWorkflowStart {}
