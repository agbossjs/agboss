import { ApplicationLoadError, openExecutionHistory } from "@agboss/core/internal";
import { applicationPathOf } from "../../cli/application-path.js";
import { loadCliApplication } from "../../cli/cli-application.js";
import { textOption, type CommandContext } from "../../cli/context.js";
import { envOption } from "../../cli/environment.js";
import { CliError } from "../../cli/errors.js";
import type { GoldenSource } from "./golden-case.js";

/**
 * Where `agboss eval ui` saves golden cases from (#397 PR 5): the application of `--application`
 * (else package.json) with its execution history opened on `--env` — nothing built, nothing run.
 * No application, one that does not load, or one that keeps no execution records turns the
 * button into why — the pages and the labels still serve.
 */

/** The source, and how to close what it opened. */
export interface OpenedGoldenSource {
  readonly source: GoldenSource;
  readonly close: () => Promise<void>;
}

const off = (reason: string): OpenedGoldenSource => ({
  source: { kind: "off", reason },
  close: () => Promise.resolve(),
});

/** The application's history, or the CLI error that stopped it loading (the pages still serve). */
async function historyOf(context: CommandContext) {
  try {
    const { application } = await loadCliApplication(context);
    return await openExecutionHistory(application, {
      env: envOption(context),
      processEnv: context.io.env,
    });
  } catch (error) {
    if (error instanceof ApplicationLoadError)
      return new CliError("project", "application.load", error.message);
    if (error instanceof CliError) return error;
    throw error;
  }
}

export async function goldenSourceOf(context: CommandContext): Promise<OpenedGoldenSource> {
  try {
    applicationPathOf(context);
  } catch (error) {
    if (error instanceof CliError && error.code === "application.path-not-set")
      return off(
        'no application here — set "agboss": { "application" } in package.json, or start agboss eval ui with --application',
      );
    throw error;
  }
  const opened = await historyOf(context);
  if (opened instanceof CliError)
    return off(`the application did not load (${opened.code}): ${opened.message}`);
  if (!opened.isKept) {
    await opened.close();
    return off(
      `${opened.application} keeps no execution records, so a run's execution cannot be read back: set @Application({ executionRecordRetention }) and run the suite again`,
    );
  }
  return {
    source: {
      kind: "kept",
      root: context.io.cwd,
      application: textOption(context.values, "application"),
      history: opened.history,
    },
    close: opened.close,
  };
}
