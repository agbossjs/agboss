import type { A2AFileOptions } from "../a2a/files/a2a-file-options.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { nameOf } from "../components/name-of.js";
import type { AgentMeta } from "../components/meta-types.js";
import type { AgentsConfigOf } from "../config/types.js";
import type { WorkflowDefaults } from "../flow/decorators/workflow.js";
import type { ModelInputKind } from "../models/content.js";
import type { ModelUse } from "../models/uses.js";
import { narrowedTypesOf } from "./file-needs.js";
import { workflowDeclarationOf } from "../components/module.js";
import type { Provider } from "../components/injection.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import type { AssembledPii } from "../pii/assembly.js";
import {
  A2AFileRepository,
  InlineA2AFileRepository,
} from "../infrastructure/a2a-file.repository.js";
import { FileRedactor, ModelImageRedactor } from "./file-redactor.js";
import { FileTranscriber, ModelFileTranscriber } from "./file-transcriber.js";
import { mergedFileDefaults, resolvedFilesOf, type ResolvedModelFiles } from "./file-settings.js";

/**
 * The agents' `files` of a workflow, resolved (#899 §1): each agent that opted in with
 * `ModelFiles.of(…)` gets its settings with every level applied, in the workflow's config.
 */

/** What the application gives its workflows' files. */
export interface FilesOwner {
  readonly defaults?: WorkflowDefaults;
  readonly a2aFiles?: A2AFileOptions;
  readonly exposes?: readonly Class[];
}

/** What one workflow's agents are resolved with. */
export interface FilesSources {
  readonly owner: FilesOwner | undefined;
  readonly workflow: Class;
  readonly agents: readonly AgentMeta[];
  readonly graph: Pick<RuntimeGraph, "starts">;
  /** The PII policies in effect per agent. */
  readonly pii: Pick<AssembledPii, "byElement">;
}

/** The application's own `FileTranscriber` (#899), not the built-in: the listed class, when there is one. */
export const ownFileTranscriberOf = (
  providers: readonly Provider[] | undefined,
): Class | undefined =>
  (providers ?? []).find(
    (provider): provider is Class =>
      typeof provider === "function" &&
      provider.prototype instanceof FileTranscriber &&
      provider !== ModelFileTranscriber,
  );

/** Whether the application lists an `A2AFileRepository` that keeps the files' bytes, not the inline default (#899 §7). */
export const hasFileStore = (providers: readonly Provider[] | undefined): boolean =>
  (providers ?? []).some(
    (provider) =>
      typeof provider === "function" &&
      provider.prototype instanceof A2AFileRepository &&
      provider !== InlineA2AFileRepository &&
      !(provider.prototype instanceof InlineA2AFileRepository),
  );

/** The application's own `FileRedactor` (#899), not the built-in: the listed class, when there is one. */
export const ownFileRedactorOf = (providers: readonly Provider[] | undefined): Class | undefined =>
  (providers ?? []).find(
    (provider): provider is Class =>
      typeof provider === "function" &&
      provider.prototype instanceof FileRedactor &&
      provider !== ModelImageRedactor,
  );

/** The `files` options of the skills of the application's exposes whose starts are the workflow's. */
function skillFilesOf(owner: FilesOwner | undefined, starts: readonly string[]): A2AFileOptions[] {
  return (owner?.exposes ?? []).flatMap((expose) => {
    const meta = componentOf(expose);
    if (meta?.kind !== "a2a-expose") return [];
    return meta.meta.exports.flatMap((start) => {
      const name = nameOf(start);
      return starts.includes(name) ? (meta.meta.skills?.[name]?.files ?? []) : [];
    });
  });
}

/** An agent's files of its sources, or none when it did not opt in. */
export function agentFilesOf(
  agent: AgentMeta,
  sources: FilesSources,
): ResolvedModelFiles | undefined {
  if (agent.files === undefined) return undefined;
  const { owner, workflow } = sources;
  const declared = workflowDeclarationOf(workflow).options.defaults?.files;
  return resolvedFilesOf({
    agent: agent.files.options,
    defaults: mergedFileDefaults(owner?.defaults?.files, declared),
    skills: skillFilesOf(owner, [...sources.graph.starts]),
    a2aFiles: owner?.a2aFiles,
    hasPiiPolicy: (sources.pii.byElement.get(agent.name) ?? []).length > 0,
  });
}

/**
 * The config with each agent's defaulted media types narrowed to the kinds its model takes (#899 §1):
 * an image-only model with the default set reads images; a PDF reaching it fails closed at run time.
 * Types the developer named are never narrowed: a model that cannot take them stopped the start.
 */
export function withNarrowedFiles(
  config: AgentsConfigOf<string>,
  inputs: ReadonlyMap<string, readonly ModelInputKind[]>,
  uses: readonly Pick<ModelUse, "key" | "forAgents">[] = [],
): AgentsConfigOf<string> {
  return {
    ...config,
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([name, settings]) => {
        // what every model that reads the agent's files takes: its own and its guardrails' and judges' (#899 §4, §8)
        const readers = [
          `agents.${name}`,
          ...uses.filter((use) => use.forAgents?.includes(name) === true).map((use) => use.key),
        ];
        const lists = readers.flatMap((key) => {
          const taken = inputs.get(key);
          return taken === undefined ? [] : [taken];
        });
        const kinds = lists.length === 0 ? undefined : intersectionOf(lists);
        const { files } = settings;
        if (files === undefined || files.isTypesExplicit || kinds === undefined)
          return [name, settings];
        return [
          name,
          { ...settings, files: { ...files, allowedMediaTypes: narrowedTypesOf(files, kinds) } },
        ];
      }),
    ),
  };
}

/** The kinds every list has. */
const intersectionOf = (lists: readonly (readonly ModelInputKind[])[]): ModelInputKind[] => {
  const [first = [], ...rest] = lists;
  return first.filter((kind) => rest.every((list) => list.includes(kind)));
};

/** The config with each opted-in agent's resolved `files`. */
export function withAgentFiles(
  config: AgentsConfigOf<string>,
  sources: FilesSources,
): AgentsConfigOf<string> {
  const files = sources.agents.flatMap((agent) => {
    const resolved = agentFilesOf(agent, sources);
    return resolved === undefined ? [] : [[agent.name, resolved] as const];
  });
  if (files.length === 0) return config;
  const byAgent = new Map(files);
  return {
    ...config,
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([name, settings]) => {
        const resolved = byAgent.get(name);
        return [name, resolved === undefined ? settings : { ...settings, files: resolved }];
      }),
    ),
  };
}
