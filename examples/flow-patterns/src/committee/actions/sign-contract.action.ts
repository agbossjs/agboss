import { Action, listOf, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { ContractDto } from "../dto/contract.dto.js";
import { SignOffDto } from "../dto/sign-off.dto.js";
import { SignedContractDto } from "../dto/signed-contract.dto.js";

/** Signs the contract once the quorum is in: it reads the approvals the arbiter counted. */
@Action({
  name: "sign-contract-action",
  description: "Signs the contract on the committee's approvals",
  input: { contract: ContractDto, signOffs: listOf(SignOffDto) },
  output: SignedContractDto,
})
export class SignContractAction implements ActionHandler<SignContractAction> {
  execute(input: InputOf<SignContractAction>): Promise<OutputOf<SignContractAction>> {
    return Promise.resolve({
      title: input.contract.title,
      signedBy: String(input.signOffs.length),
    });
  }
}
