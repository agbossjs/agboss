import { inspect } from "node:util";
import { Channel } from "../components/decorators.js";
import { agbossComponent } from "../flow/generated-types.js";
import type { ChannelAsk } from "./channel-handler.js";
import { ChannelOutcome } from "./channel-outcome.js";

/** Asks in the terminal: prints the call; `agboss chat` then asks for the decision and resumes. */
@Channel({
  name: "terminal-user-channel",
  description: "Asks the user via terminal standard output and waits for CLI input",
})
export class TerminalUserChannel {
  declare readonly [agbossComponent]?: "terminal-user-channel";

  send(ask: ChannelAsk<TerminalUserChannel>): Promise<ChannelOutcome<TerminalUserChannel>> {
    const { tool, arguments: args } = ask.value;
    const lines = [
      "",
      `[APPROVAL REQUIRED] Tool '${tool}' wants to run (pause ${ask.pauseId}).`,
      `Arguments: ${inspect(args, { depth: 4 })}`,
      "Answer the prompt in this terminal, or from code: app.resume(thread, { approved, by }).",
      "",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}
