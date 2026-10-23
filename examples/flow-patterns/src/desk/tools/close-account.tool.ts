import { Tool, type ToolHandler } from "agboss";
import { AccountClosedDto, AccountClosureDto } from "../dtos/account-closure.dto.js";

/** Closes an account — on the desk's agent so a model can ask; its interceptor blocks every call. */
@Tool({
  name: "close-account-tool",
  description: "Closes a customer's account",
  input: AccountClosureDto,
  output: AccountClosedDto,
})
export class CloseAccountTool implements ToolHandler<AccountClosureDto, AccountClosedDto> {
  run(): Promise<AccountClosedDto> {
    return Promise.resolve({ closed: true });
  }
}
