import { hasFileAtAnyDepth } from "../a2a/files/a2a-file.dto.js";
import type { AgentsConfigOf } from "../config/types.js";
import { NodeKind } from "../flow/ast.js";
import { classesOf } from "../flow/runtime/answer-tools.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import type { ElementGuardrails } from "../guardrails/assembly.js";
import type { InputNeed } from "../models/uses.js";
import { needsOf } from "./file-needs.js";
import type { ResolvedModelFiles } from "./file-settings.js";
import { FileSource } from "./model-files.js";

/**
 * The models that read an agent's files besides its own (#899 §4, §8): its input guardrails, its output
 * guardrails when its answer holds files, its judges. Each is a model use with what it must take, so a
 * model that cannot take a file's type stops the application at start (`[model.unsupported-input]`) —
 * where its provider reports input kinds.
 */

/** What a guardrail's or a judge's model reads of files, and which agents' files those are. */
export interface FileReader {
  readonly needs: readonly InputNeed[];
  /** Whether an agent that sets its media types is among them: a model that cannot take one is refused, not narrowed. */
  readonly isNeedStrict: boolean;
  readonly agents: readonly string[];
}

/** Whether an agent's output holds a file at any depth. */
export function answersWithFiles(graph: Pick<RuntimeGraph, "nodes">, name: string): boolean {
  const declaration = graph.nodes.get(name)?.declaration;
  if (declaration?.kind !== NodeKind.Agent) return false;
  const { output } = declaration.options;
  return output !== undefined && classesOf(output).some((dto) => hasFileAtAnyDepth(dto));
}

/** Whether an agent's input guardrails read files: its input, or its tool results while they are guarded. */
const guardsFiles = (files: ResolvedModelFiles): boolean =>
  files.sources.includes(FileSource.Input) ||
  (files.sources.includes(FileSource.ToolResults) && files.guardToolResultFiles);

interface Reading {
  readonly agent: string;
  readonly files: ResolvedModelFiles;
}

/** Several agents' readings of one model as one reader; none for no reading. */
function readerOf(readings: readonly Reading[]): FileReader | undefined {
  // Stryker disable next-line ConditionalExpression: readerOf is called with the non-empty list its map holds: an empty one is never given
  if (readings.length === 0) return undefined;
  const seen = new Set<string>();
  const needs = readings.flatMap(({ files }) =>
    needsOf(files).filter((need) => {
      const key = `${need.kind}:${need.mediaType}:${need.view}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
  return {
    needs,
    isNeedStrict: readings.some(({ files }) => files.isTypesExplicit),
    agents: readings.map(({ agent }) => agent),
  };
}

/** What each model guardrail reads: the files of the agents it guards, as they guard them. */
export function guardrailReadersOf(
  config: AgentsConfigOf<string>,
  byElement: ReadonlyMap<string, ElementGuardrails>,
  graph: Pick<RuntimeGraph, "nodes">,
): ReadonlyMap<string, FileReader> {
  const readings = new Map<string, Reading[]>();
  const add = (guardrail: string, reading: Reading): void => {
    readings.set(guardrail, [...(readings.get(guardrail) ?? []), reading]);
  };
  for (const [agent, settings] of Object.entries(config.agents)) {
    const { files } = settings;
    const guards = byElement.get(agent);
    if (files === undefined || guards === undefined) continue;
    if (guardsFiles(files))
      for (const guardrail of guards.input) add(guardrail.name, { agent, files });
    if (answersWithFiles(graph, agent))
      for (const guardrail of guards.output) add(guardrail.name, { agent, files });
  }
  return new Map(
    [...readings].flatMap(([name, list]) => {
      const reader = readerOf(list);
      // Stryker disable next-line ConditionalExpression, ArrayDeclaration: a reader is never undefined (see readerOf): the [] arm is unreachable
      return reader === undefined ? [] : [[name, reader] as const];
    }),
  );
}

/** What each judge reads: everything the model read of the files of the agents it judges. */
export function judgeReadersOf(config: AgentsConfigOf<string>): ReadonlyMap<string, FileReader> {
  const readings = new Map<string, Reading[]>();
  for (const [agent, settings] of Object.entries(config.agents)) {
    const { files } = settings;
    if (files === undefined) continue;
    for (const judge of settings.judges ?? [])
      readings.set(judge, [...(readings.get(judge) ?? []), { agent, files }]);
  }
  return new Map(
    [...readings].flatMap(([name, list]) => {
      const reader = readerOf(list);
      // Stryker disable next-line ConditionalExpression, ArrayDeclaration: a reader is never undefined (see readerOf): the [] arm is unreachable
      return reader === undefined ? [] : [[name, reader] as const];
    }),
  );
}
