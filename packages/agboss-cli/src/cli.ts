import { createApp, type App, type ExecutionOutput } from "agboss";
import { executeUnchecked, type ApplicationStart, type RunStreamEvent } from "agboss/internal";
import "dotenv/config";
import { createInterface } from "node:readline";
import { styleText } from "node:util";
import { askWith } from "./cli/ask.js";
import { memoryLine, outputText, summaryLine, threadLine, untilDone } from "./cli/approve.js";
import { loadChosenStart } from "./cli/cli-application.js";
import { textOption, type CommandContext, type CommandHandler } from "./cli/context.js";
import { costSummary, costTotal, costTrace } from "./cli/finops.js";
import { envOption } from "./cli/environment.js";
import { runInputOf } from "./cli/run-input.js";

/** The reply streams to stdout (stderr under --json); tool use and the summary go to stderr. */
function streamTo(context: CommandContext): (event: RunStreamEvent) => void {
  const reply = context.json ? context.io.stderr : context.io.stdout;
  return (event) => {
    if (event.kind === "textDelta") reply.write(event.delta);
    else context.warn(styleText("dim", `\n[Agent is using tool: ${event.tool}]`));
  };
}

async function execute(
  context: CommandContext,
  app: App,
  start: ApplicationStart,
  input: unknown,
): Promise<ExecutionOutput> {
  const thread = textOption(context.values, "thread");
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    const first = await executeUnchecked(app, start.component, input, {
      ...(thread === undefined ? {} : { threadId: thread }),
      onStream: streamTo(context),
    });
    return await untilDone(
      first,
      app,
      askWith(rl, (text) => context.io.stderr.write(text)),
    );
  } finally {
    rl.close();
  }
}

function report(context: CommandContext, app: App, result: ExecutionOutput): void {
  (context.json ? context.io.stderr : context.io.stdout).write("\n");
  context.warn(`${threadLine(result)}  (continue with --thread ${result.threadId})`);
  context.warn(`config: ${app.name} | ${summaryLine(result)}`);
  const memory = memoryLine(result);
  if (memory !== undefined) context.warn(memory);
  context.warn(`cost: ${costSummary(result.spend)}`);
  costTrace(result.spend).forEach((line) => {
    context.warn(`  ${line}`);
  });
  context.warn(costTotal(result.spend));
}

/**
 * `agboss run [--start <name>] ("<task>" | --input <json> | --input-file <file>) [--thread <id>]
 * [--profile <p>] [--env <id>]` — the input is checked against the start before the app starts.
 */
export const handle: CommandHandler = async (context) => {
  const { application, start } = await loadChosenStart(context);
  const input = runInputOf(context, start);
  const app = await createApp(application, {
    profile: textOption(context.values, "profile"),
    profileRoot: context.io.cwd,
    env: envOption(context),
    processEnv: context.io.env,
  });
  // the startup warnings are in the app's start log (its Logger); --json returns them too
  try {
    const result = await execute(context, app, start, input);
    report(context, app, result);
    const { threadId: thread, status, finish, output: answer } = result;
    const output = {
      start: start.name,
      thread,
      status,
      text: outputText(result),
      ...(finish === undefined ? {} : { finish: finish.name, output: answer }),
      cost: costTotal(result.spend),
    };
    return { result: output, warnings: app.warnings };
  } finally {
    await app.close();
  }
};
