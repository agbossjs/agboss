import { Injectable } from "@agboss/core";

/**
 * The terminal an approval is asked in: its standard error, where `agboss run` asks for the answer
 * too — so `--json` keeps standard output for its envelope.
 */
@Injectable()
export class ApprovalTerminal {
  print(lines: readonly string[]): void {
    process.stderr.write(`${lines.join("\n")}\n`);
  }
}
