import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/cli/commands.js";
import type { CliIo, CommandContext } from "../../src/cli/context.js";
import { CliError } from "../../src/cli/errors.js";
import { parseCommand } from "../../src/cli/parse.js";

const RUN = COMMANDS.run ?? { summary: "", usage: "", options: [] };
const io: CliIo = { stdout: process.stdout, stderr: process.stderr, env: {}, cwd: process.cwd() };

const runContext = (argv: readonly string[]): CommandContext => ({
  command: "run",
  ...parseCommand("run", RUN, argv),
  json: false,
  io,
  say: () => undefined,
  warn: () => undefined,
});

describe('#268: agboss run --start <name> "task" | --input <json>', () => {
  it("parses the start, the input and the task's words", () => {
    const context = runContext(["--start", "chat-workflow-start", "find", "jobs"]);

    expect(context.values.start).toBe("chat-workflow-start");
    expect(context.positionals).toEqual(["find", "jobs"]);
    expect(runContext(["--input", '{"text":"hi"}']).values.input).toBe('{"text":"hi"}');
    expect(runContext(["--input-file", "input.json"]).values["input-file"]).toBe("input.json");
  });

  it("an option missing its value is a usage error naming it", () => {
    expect(() => parseCommand("run", RUN, ["--start"])).toThrow(
      new CliError(
        "usage",
        "usage.option-value",
        "option --start needs a value — see agboss help run",
      ),
    );
  });

  it("AC1: --workflow is gone — an unknown option", () => {
    expect(() => parseCommand("run", RUN, ["--workflow", "src/a.workflow.ts"])).toThrow(
      new CliError(
        "usage",
        "usage.unknown-option",
        "unknown option --workflow — see agboss help run",
      ),
    );
  });
});
