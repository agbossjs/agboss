import { ExternalTask, PauseRespondent } from "@agboss/core";
import { hours } from "@agboss/core/units";
import { ContractDto } from "../dto/contract.dto.js";
import { SignOffDto } from "../dto/sign-off.dto.js";

/** Legal signs off the contract's terms: the company's lawyer answers through their channel. */
@ExternalTask({
  name: "legal-sign-off-external-task",
  description: "Legal signs off the contract's terms",
  input: ContractDto,
  output: SignOffDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
})
export class LegalSignOffExternalTask {}
