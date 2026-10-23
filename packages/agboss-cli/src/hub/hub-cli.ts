import {
  textOption,
  type CommandContext,
  type CommandHandler,
  type CommandOutcome,
} from "../cli/context.js";
import { CliError, usageError } from "../cli/errors.js";
import { sizeText } from "../eval/html/format.js";
import { MAX_HTML_REPORT_SIZE } from "../eval/html/bounded-page.js";
import { writeOutputFile } from "../eval/output-file.js";
import type { HubInputs } from "./hub-inputs.js";
import { meshOf, type HubMesh } from "./mesh.js";
import { readHubInputs } from "./read-inputs.js";

/**
 * `agboss hub show <path…> [--html <file>]` (#401 PR 3, S2 Q1 / Q6): the mesh of many applications
 * read from their files — no project, no application assembled, no network — printed as a summary,
 * and with `--html` written as one self-contained page within #397's size bound
 * (`hub.report-too-large` above it). `--json`: the applications, the inputs, the edges, the page.
 */

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

function summaryLines(mesh: HubMesh): string[] {
  const workflows = mesh.applications.reduce(
    (total, application) => total + application.workflows.length,
    0,
  );
  return [
    `hub: ${plural(mesh.applications.length, "application")} · ${plural(workflows, "workflow")} · ${plural(mesh.edges.length, "observed cross-service edge")}`,
    `${plural(mesh.trees.length, "execution tree")} across applications · ${plural(mesh.radar.filter((step) => step.isCandidate).length, "crystallization candidate")}`,
    `snapshots ${String(mesh.inputs.describe)} · eval runs ${String(mesh.inputs.evalRuns)} · kept executions ${String(mesh.inputs.records)}`,
  ];
}

/** The page, written; refused above the bound. */
async function writePage(context: CommandContext, path: string, mesh: HubMesh): Promise<number> {
  const { renderHubPage } = await import("./html/hub-page.js");
  const page = renderHubPage(mesh);
  const bytes = Buffer.byteLength(page, "utf8");
  if (bytes > MAX_HTML_REPORT_SIZE)
    throw new CliError(
      "usage",
      "hub.report-too-large",
      `the hub page would be ${sizeText(bytes)}, above its ${sizeText(MAX_HTML_REPORT_SIZE)} limit: give fewer exported executions (${path} not written)`,
    );
  writeOutputFile(context, path, page);
  context.say(`report → ${path} (${sizeText(bytes)}, self-contained)`);
  return bytes;
}

const resultOf = (inputs: HubInputs, mesh: HubMesh) => ({
  applications: inputs.applications.map(({ name, version, file }) => ({ name, version, file })),
  inputs: { ...mesh.inputs, files: inputs.files },
  edges: { observed: mesh.edges },
  trees: mesh.trees.map(({ root, applications, executions, stubs }) => ({
    rootExecutionId: root.executionId,
    application: root.application,
    applications,
    executions,
    stubs,
  })),
  radar: mesh.radar,
});

async function hubShowCommand(context: CommandContext): Promise<CommandOutcome> {
  const paths = context.positionals.slice(1);
  if (paths.length === 0)
    throw usageError("hub show", "usage.missing-argument", "expected agboss hub show <path…>");
  const inputs = readHubInputs(context.io.cwd, paths);
  const mesh = meshOf(inputs);
  summaryLines(mesh).forEach(context.say);
  const html = textOption(context.values, "html");
  if (html === undefined) return { result: resultOf(inputs, mesh) };
  const bytes = await writePage(context, html, mesh);
  return { result: { ...resultOf(inputs, mesh), report: html, bytes }, created: [html] };
}

/** `agboss hub <subcommand>`: the one the CLI parsed, first of the positionals. */
export const handle: CommandHandler = (context) => {
  const [subcommand] = context.positionals;
  if (subcommand === "show") return hubShowCommand(context);
  throw usageError("hub", "usage.unknown-command", `unknown subcommand "hub ${subcommand ?? ""}"`);
};
