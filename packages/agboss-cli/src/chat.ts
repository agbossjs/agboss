import { createApp, loadWorkflowClass, type App, type ExecutionOutput } from "agboss";
import { executeUnchecked, loadApplicationClass, textStartOfWorkflow } from "agboss/internal";
import "dotenv/config";
import { stdin } from "node:process";
import { createInterface } from "node:readline";
import { styleText } from "node:util";
import {
  memoryLine,
  outputText,
  summaryLine,
  threadLine,
  untilDone,
  type Ask,
} from "./cli/approve.js";
import { askWith } from "./cli/ask.js";
import {
  loadOptions,
  textOption,
  workflowPath,
  type CommandContext,
  type CommandHandler,
} from "./cli/context.js";
import { costSummary, costTotal, costTrace } from "./cli/finops.js";
import { onInterruptKey } from "./cli/keys.js";
import { envOption } from "./cli/environment.js";
import { askMessage } from "./cli/multiline.js";
import { withSpinner, type SpinnerOutput } from "./cli/spinner.js";
import { textStartOrFail } from "./cli/text-start.js";

/** One chat session: the app, how it asks, and the conversation it continues. */
interface Session {
  readonly app: App;
  readonly start: ReturnType<typeof textStartOrFail>;
  readonly ask: Ask;
  readonly say: (text: string) => void;
  readonly out: SpinnerOutput;
  thread: string | undefined;
  interrupted: boolean;
}

/** A turn: loader, and Esc / Ctrl+C abort it through its signal. */
function busyOf(session: Session) {
  return async <T>(work: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const stopKeys = onInterruptKey(stdin, () => {
      session.interrupted = true;
      controller.abort();
    });
    try {
      return await withSpinner(session.out, "thinking · esc to interrupt", () =>
        work(controller.signal),
      );
    } finally {
      stopKeys();
    }
  };
}

function showResult(session: Session, result: ExecutionOutput): void {
  const { say } = session;
  say(`${styleText("cyan", "agent ›")} ${outputText(result)}`);
  say(styleText("dim", `  ${threadLine(result)}`));
  say(styleText("dim", `  ${summaryLine(result)}`));
  const memory = memoryLine(result);
  if (memory !== undefined) say(styleText("dim", `  ${memory}`));
  say(styleText("dim", `  ${costSummary(result.spend)}`));
  costTrace(result.spend).forEach((line) => {
    say(styleText("dim", `    ${line}`));
  });
  say(styleText("bold", `  ${costTotal(result.spend)}`));
}

async function turn(session: Session, line: string): Promise<void> {
  const busy = busyOf(session);
  try {
    const thread = session.thread === undefined ? {} : { thread: session.thread };
    session.interrupted = false;
    const first = await busy((signal) =>
      executeUnchecked(session.app, session.start, { text: line }, { ...thread, signal }),
    );
    const result = await untilDone(first, session.app, session.ask, busy);
    session.thread = result.thread;
    showResult(session, result);
  } catch (error) {
    if (session.interrupted) session.say(styleText("yellow", "interrupted"));
    else
      session.say(
        styleText("red", `error › ${error instanceof Error ? error.message : String(error)}`),
      );
  }
}

async function converse(session: Session): Promise<void> {
  for (;;) {
    const line = (
      await askMessage(session.ask, styleText("bold", "you › "), styleText("dim", "  … "))
    )?.trim();
    if (line === undefined || line === "/exit") return;
    if (line === "") continue;
    if (line === "/new") {
      session.thread = undefined;
      session.say(styleText("dim", "— new conversation —"));
      continue;
    }
    await turn(session, line);
  }
}

/** Until #268: the application that lists the --workflow (its module, or *.application.ts beside it). */
async function appOf(context: CommandContext, file: string): Promise<App> {
  return createApp(await loadApplicationClass(file, loadOptions(context)), {
    profile: textOption(context.values, "profile"),
    profileRoot: context.io.cwd,
    env: envOption(context),
    processEnv: context.io.env,
  });
}

/** `agboss chat --workflow <path> [--thread <id>] [--profile <p>] [--env <id>]`. */
export const handle: CommandHandler = async (context) => {
  const file = workflowPath(context);
  const app = await appOf(context, file);
  const workflow = await loadWorkflowClass(file, loadOptions(context));
  const out = context.json ? process.stderr : process.stdout;
  const rl = createInterface({ input: stdin, terminal: false });
  const say = (text: string): void => {
    out.write(`${text}\n`);
  };
  const session: Session = {
    app,
    start: textStartOrFail({ name: app.name, textStart: textStartOfWorkflow(app, workflow) }),
    ask: askWith(rl, (text) => out.write(text)),
    say,
    out,
    thread: textOption(context.values, "thread"),
    interrupted: false,
  };
  app.models.forEach((line) => {
    say(styleText("dim", `model ${line}`));
  });
  app.warnings.forEach((warning) => {
    say(`warning: ${warning}`);
  });
  const profile = textOption(context.values, "profile");
  say(
    styleText(
      "dim",
      `Chat with "${app.name}"${profile === undefined ? "" : ` (profile ${profile})`} ${app.version}. /new — new conversation, /exit — quit, \\ + Enter — new line, Esc — interrupt.`,
    ),
  );
  try {
    await converse(session);
  } finally {
    rl.close();
    await app.close();
  }
  return { result: { thread: session.thread ?? null }, warnings: app.warnings };
};
