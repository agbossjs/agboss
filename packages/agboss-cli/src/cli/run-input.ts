import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkflowStartTextDto } from "agboss/dto";
import { startInputIssuesOf, type ApplicationStart } from "agboss/internal";
import { textOption, type CommandContext } from "./context.js";
import { usageError } from "./errors.js";

/**
 * What `agboss run` gives its start (#268 AC3): a text (`agboss run "<task>"`, only for a start
 * taking `WorkflowStartTextDto`), `--input '<json>'` or `--input-file <file>` — exactly one. The
 * value is checked against the start's input (one DTO, a `listOf(…)` or a map of fields) before
 * anything starts: every problem at once, by field.
 */

/** Where the input came from, for messages. */
type InputSource = "the task" | "--input" | "--input-file";

interface GivenInput {
  readonly source: InputSource;
  readonly value: unknown;
}

const usage = (code: string, message: string): Error => usageError("run", code, message);

function parsedJson(text: string, source: InputSource): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw usage("input.not-json", `${source} is not JSON: ${reason}`);
  }
}

function fileText(context: CommandContext, path: string): string {
  const file = resolve(context.io.cwd, path);
  if (!existsSync(file)) throw usage("input.file-not-found", `--input-file not found: ${file}`);
  return readFileSync(file, "utf8");
}

/** The one input given: the task's words, `--input` or `--input-file`. */
function givenInput(context: CommandContext, start: ApplicationStart): GivenInput {
  const json = textOption(context.values, "input");
  const file = textOption(context.values, "input-file");
  const task = context.positionals.join(" ");
  const given = [json, file, task.trim() === "" ? undefined : task].filter(
    (value) => value !== undefined,
  );
  if (given.length > 1)
    throw usage(
      "input.twice",
      'give the input once: "<task>", --input <json> or --input-file <file>',
    );
  if (json !== undefined) return { source: "--input", value: parsedJson(json, "--input") };
  if (file !== undefined)
    return { source: "--input-file", value: parsedJson(fileText(context, file), "--input-file") };
  if (task.trim() === "")
    throw usage(
      "input.missing",
      `missing the input of ${start.name}: "<task>", --input <json> or --input-file <file>`,
    );
  if (start.input !== WorkflowStartTextDto)
    throw usage(
      "input.not-text",
      `${start.name} does not take a text: give its input with --input <json> or --input-file <file>`,
    );
  return { source: "the task", value: { text: task } };
}

/** The input for the chosen start, checked against its `InputOf` — every issue, by field. */
export function runInputOf(context: CommandContext, start: ApplicationStart): unknown {
  const { source, value } = givenInput(context, start);
  const issues = startInputIssuesOf(start.component, value);
  if (issues.length === 0) return value;
  const fields = issues.map((issue) => `${issue.path}: ${issue.reason}`).join("; ");
  throw usage("input.invalid", `${source} does not fit the input of ${start.name}: ${fields}`);
}
