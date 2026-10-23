import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  exportedRecordLine,
  historyRecordsOf,
  openExecutionHistory,
  type HistoryExportQuery,
  type OpenedExecutionHistory,
} from "agboss/internal";
import { loadCliApplication } from "./cli/cli-application.js";
import {
  flagOption,
  requiredText,
  textOption,
  type CommandContext,
  type CommandHandler,
} from "./cli/context.js";
import { envOption } from "./cli/environment.js";
import { CliError, usageError } from "./cli/errors.js";

/**
 * `agboss records export (--tenant <id> | --all-tenants) --out <file.jsonl> [--since <date>]
 * [--until <date>] [--env <name>]` (#401 PR 1): the application's kept root executions — its
 * `ExecutionHistoryRepository`, opened without running anything — as JSON Lines, one masked record
 * per line (`kind: "agboss.execution-record"`), oldest start first. A tenant is always named, or all
 * of them explicitly; an application that keeps none (no `executionRecordRetention`) is
 * `records.not-kept`.
 */

const COMMAND = "records export";

/** The far ends of a period nobody gave. */
const EARLIEST = new Date("1970-01-01T00:00:00.000Z");
const LATEST = new Date("9999-12-31T23:59:59.999Z");

/** `--since` / `--until`: an ISO 8601 date or time. */
function dateOption(context: CommandContext, name: string, fallback: Date): Date {
  const given = textOption(context.values, name);
  if (given === undefined) return fallback;
  const at = new Date(given);
  if (!Number.isNaN(at.getTime())) return at;
  throw usageError(
    COMMAND,
    "usage.option-value",
    `option --${name} needs an ISO 8601 date or time (2026-10-16 or 2026-10-16T09:00:00Z), got "${given}"`,
  );
}

/** Whose records: `--tenant <id>`, or `--all-tenants` — exactly one. */
function tenantOf(context: CommandContext): string | undefined {
  const tenant = textOption(context.values, "tenant");
  const isAll = flagOption(context.values, "all-tenants");
  if ((tenant === undefined) === isAll) return tenant;
  throw usageError(
    COMMAND,
    "records.tenant-required",
    "name the tenant whose records to export with --tenant <id>, or every tenant's with --all-tenants (one of them)",
  );
}

/** The query the options say. */
function queryOf(context: CommandContext): HistoryExportQuery {
  return {
    tenantId: tenantOf(context),
    from: dateOption(context, "since", EARLIEST),
    to: dateOption(context, "until", LATEST),
  };
}

/** Writes every record of the query to `file`, one line each; how many. */
async function writeRecords(
  opened: OpenedExecutionHistory,
  query: HistoryExportQuery,
  file: string,
): Promise<number> {
  mkdirSync(dirname(file), { recursive: true });
  const handle = openSync(file, "w");
  let count = 0;
  try {
    for await (const record of historyRecordsOf(opened.history, query)) {
      writeSync(handle, `${exportedRecordLine(record)}\n`);
      count += 1;
    }
  } finally {
    closeSync(handle);
  }
  return count;
}

export const handle: CommandHandler = async (context) => {
  if (context.positionals[0] !== "export" || context.positionals.length > 1)
    throw usageError("records", "usage.missing-argument", 'expected "agboss records export …"');
  const query = queryOf(context);
  const out = requiredText(context.values, "out");
  const { application } = await loadCliApplication(context);
  const opened = await openExecutionHistory(application, {
    env: envOption(context),
    processEnv: context.io.env,
  });
  try {
    if (!opened.isKept)
      throw new CliError(
        "project",
        "records.not-kept",
        `${opened.application} keeps no execution records: set @Application({ executionRecordRetention }) to keep them`,
      );
    const file = resolve(context.io.cwd, out);
    const records = await writeRecords(opened, query, file);
    const whose = query.tenantId ?? "every tenant";
    context.say(`records: ${String(records)} executions (${whose}) → ${out}`);
    return { result: { records, tenantId: query.tenantId ?? null, file: out }, created: [out] };
  } finally {
    await opened.close();
  }
};
