import { ExternalTask, PauseRespondent } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { ContractDto } from "../dto/contract.dto.js";
import { SignOffDto } from "../dto/sign-off.dto.js";

/** The finance director signs off the contract's cost: the finance director answers through their channel. */
@ExternalTask({
  name: "finance-director-sign-off-external-task",
  description: "The finance director signs off the contract's cost",
  input: ContractDto,
  output: SignOffDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
})
export class FinanceDirectorSignOffExternalTask {}
