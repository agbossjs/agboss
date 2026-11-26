import { StreamEventKind, type App, type ExecutionOutput } from "@agboss/core";
import {
  createAppWith,
  executeWithoutInputCheck,
  type ApplicationStart,
  type ExecutionStreamEvent,
} from "@agboss/core/internal";
import { createInterface } from "node:readline";
import { styleText } from "node:util";
import { askWith } from "./cli/ask.js";
import {
  memoryLine,
  outputText,
  summaryLine,
  threadLine,
  unstreamedAnswer,
  untilDone,
} from "./cli/approve.js";
import { KeptText } from "./cli/kept-text.js";
import { loadChosenStart } from "./cli/cli-application.js";
import { textOption, type CommandContext, type CommandHandler } from "./cli/context.js";
import { costSummary, costTotal, costTrace } from "./cli/finops.js";
import { runInputOf } from "./cli/run-input.js";

/** The reply streams to stdout (stderr under --json); tool use and the summary go to stderr. */
function streamTo(context: CommandContext, kept: KeptText): (event: ExecutionStreamEvent) => void {
  const reply = context.json ? context.io.stderr : context.io.stdout;
  return (event) => {
    kept.hear(event);
    switch (event.kind) {
      case StreamEventKind.TextDelta:
        reply.write(event.delta);
        break;
      case StreamEventKind.Discarded:
        // a terminal cannot unwrite: say what is no longer the answer, then go on from a new line
        context.warn(styleText("dim", `\n[Retracted: ${event.reason}]`));
        break;
      case StreamEventKind.ToolCall:
        context.warn(styleText("dim", `\n[Agent is using tool: ${event.tool}]`));
        break;
    }
  };
}

async function execute(
  context: CommandContext,
  app: App,
  start: ApplicationStart,
  input: unknown,
  kept: KeptText,
): Promise<ExecutionOutput> {
  const thread = textOption(context.values, "thread");
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    // listening before the first leg runs: a line piped at once (`echo y | agboss run …`) is kept
    // for the approval prompt, not lost while the agent works
    const ask = askWith(rl, (text) => context.io.stderr.write(text));
    // the resumed runs after a pause stream to the same terminal (#1123)
    const onStream = streamTo(context, kept);
    const first = await executeWithoutInputCheck(app, start.component, input, {
      ...(thread === undefined ? {} : { threadId: thread }),
      onStream,
    });
    return await untilDone(first, app, ask, undefined, onStream);
  } finally {
    rl.close();
  }
}

function report(context: CommandContext, app: App, result: ExecutionOutput, kept: KeptText): void {
  const reply = context.json ? context.io.stderr : context.io.stdout;
  // what streamed and was not retracted is not the output (nothing streamed, a retracted text, an
  // earlier step's): the answer is the result's
  const answer = context.json ? undefined : unstreamedAnswer(result, kept.text());
  if (answer !== undefined) reply.write(answer);
  reply.write("\n");
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
 * [--profile <p>]` — the input is checked against the start before the app starts.
 */
export const handle: CommandHandler = async (context) => {
  const { application, start } = await loadChosenStart(context);
  const input = runInputOf(context, start);
  const app = await createAppWith(application, {
    profile: textOption(context.values, "profile"),
    processEnv: context.io.env,
  });
  // the startup warnings are in the app's start log (its Logger); --json returns them too
  try {
    const kept = new KeptText();
    const result = await execute(context, app, start, input, kept);
    report(context, app, result, kept);
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
