import { ExternalTask, PauseRespondent } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { ContractDto } from "../dto/contract.dto.js";
import { SignOffDto } from "../dto/sign-off.dto.js";

/** Security signs off the contract's data handling: the security team answers through their channel. */
@ExternalTask({
  name: "security-sign-off-external-task",
  description: "Security signs off the contract's data handling",
  input: ContractDto,
  output: SignOffDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
})
export class SecuritySignOffExternalTask {}
