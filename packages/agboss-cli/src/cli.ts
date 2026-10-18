import { createApp, loadWorkflowClass, type App, type Class, type ExecutionOutput } from "agboss";
import {
  executeUnchecked,
  loadApplicationClass,
  textStartOfWorkflow,
  type RunStreamEvent,
} from "agboss/internal";
import "dotenv/config";
import { createInterface } from "node:readline";
import { styleText } from "node:util";
import { askWith } from "./cli/ask.js";
import { memoryLine, outputText, summaryLine, threadLine, untilDone } from "./cli/approve.js";
import {
  loadOptions,
  textOption,
  type CommandContext,
  type CommandHandler,
} from "./cli/context.js";
import { costSummary, costTotal, costTrace } from "./cli/finops.js";
import { envOption } from "./cli/environment.js";
import { runTargetOf } from "./cli/run-target.js";
import { textStartOrFail } from "./cli/text-start.js";

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
  start: Class,
  task: string,
): Promise<ExecutionOutput> {
  const thread = textOption(context.values, "thread");
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    const first = await executeUnchecked(
      app,
      start,
      { text: task },
      { ...(thread === undefined ? {} : { thread }), onStream: streamTo(context) },
    );
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
  context.warn(`${threadLine(result)}  (continue with --thread ${result.thread})`);
  context.warn(`config: ${app.name} | ${summaryLine(result)}`);
  const memory = memoryLine(result);
  if (memory !== undefined) context.warn(memory);
  context.warn(`cost: ${costSummary(result.spend)}`);
  costTrace(result.spend).forEach((line) => {
    context.warn(`  ${line}`);
  });
  context.warn(costTotal(result.spend));
}

/** `agboss run --workflow <path> [--thread <id>] [--profile <p>] [--env <id>] "<task>"`. */
export const handle: CommandHandler = async (context) => {
  const { file, task } = runTargetOf(context);
  // until #268: the application that lists the --workflow (its module, or *.application.ts beside it)
  const app = await createApp(await loadApplicationClass(file, loadOptions(context)), {
    profile: textOption(context.values, "profile"),
    profileRoot: context.io.cwd,
    env: envOption(context),
    processEnv: context.io.env,
  });
  app.warnings.forEach((warning) => {
    context.warn(`warning: ${warning}`);
  });
  try {
    const workflow = await loadWorkflowClass(file, loadOptions(context));
    const start = textStartOrFail({
      name: app.name,
      textStart: textStartOfWorkflow(app, workflow),
    });
    const result = await execute(context, app, start, task);
    report(context, app, result);
    const { thread, status, finish, output: answer } = result;
    const output = {
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
