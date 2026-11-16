import { DEFAULT_FILE_FETCH_TIMEOUT } from "../a2a/files/a2a-file-options.js";
import type { FileTransport } from "../a2a/files/a2a-file-transport.js";
import { currentFrame, rootFactsOf } from "../flow/context/frame.js";
import { A2AFileRepository } from "../infrastructure/a2a-file.repository.js";
import { ExecutionRecordRepository } from "../infrastructure/execution-record.repository.js";
import { lazyLoad, systemClock } from "../infrastructure/clock.js";
import type { BudgetMeter } from "../budgets/execution-budgets.js";
import { recordReportedCost } from "../finops/usage.js";
import type { AgentDefinition } from "../graph/agent-loop/deps.js";
import type { GraphDeps } from "../graph/deps.js";
import { contextMeshSettingsOf } from "../mesh/mesh-settings.js";
import { kilobytes } from "../units/index.js";
import { valuesForRedactor } from "./redaction-values.js";
import type { FileContent, FileReadContext } from "./file-bytes.js";
import type { ResolvedModelFiles } from "./file-settings.js";
import type { UsageRecord } from "../finops/usage.js";
import type { Usd } from "../units/index.js";
import {
  FileRedactor,
  ModelImageRedactor,
  type RedactionPlan,
  type RedactionResult,
} from "./file-redactor.js";
import {
  FileTranscriber,
  ModelFileTranscriber,
  type TranscriptionResult,
} from "./file-transcriber.js";
import type { FileRuntime } from "./visit-files.js";

/** The most turns of a thread looked at for the executions that own its files. */
const THREAD_TURNS = 1000;

/** The https transport, loaded at the first download: its tracing is not part of the root import. */
const lazyHttpsTransport: FileTransport = async (url, signal) => {
  const { httpsFileTransport } = await lazyLoad(import("../a2a/files/a2a-file-transport.js"));
  return httpsFileTransport(url, signal);
};

/**
 * What an agent's loop reads its files with (#899), made once per agent from the workflow's deps: the
 * file store and the transcriber the application's container made, the agent's transcription model, the
 * frame of the execution that runs it (its tenant, its task, its signal).
 */

/** The execution a read runs in; a file belongs to its execution's task, so outside one there is none. */
function executionOf() {
  const execution = currentFrame()?.execution;
  if (execution === undefined) throw new TypeError("a model's files are read inside an execution");
  return execution;
}

/** The read context of the execution the agent runs in: its store, its task, its signal and limits. */
function readContextOf(deps: GraphDeps<string>, settings: ResolvedModelFiles): FileReadContext {
  const execution = executionOf();
  const limits = contextMeshSettingsOf(execution.tenant.application)?.a2aFiles;
  return {
    store: deps.container.get(A2AFileRepository),
    tenantId: execution.tenant.tenantId,
    ownerId: rootFactsOf(execution).executionId,
    signal: execution.signal,
    clock: deps.clock ?? systemClock,
    transport: lazyHttpsTransport,
    allowedOrigins: limits?.allowedFileOrigins ?? [],
    fetchTimeout: DEFAULT_FILE_FETCH_TIMEOUT,
    // the settings hold a plain number of bytes: dividing by 1,024 is exact, `kilobytes` multiplies back
    maxFileSize: kilobytes(settings.maxFileSize / 1024),
  };
}

/** The root executions of the thread the agent runs in: whose files a history file may be. */
async function threadOwnersOf(deps: GraphDeps<string>): Promise<readonly string[]> {
  const { tenant, threadId } = executionOf();
  const turns = await deps.container
    .get(ExecutionRecordRepository)
    .lastTurns(tenant.tenantId, threadId, THREAD_TURNS);
  return turns.flatMap((turn) => (turn.runId === null ? [] : [turn.runId]));
}

/** What a project's own service reported it cost, as the spend of the call (a model call reports its own). */
const withReportedCost = <T extends { readonly cost?: Usd; readonly usage?: UsageRecord }>(
  result: T,
  caller: string,
  name: string,
): T =>
  result.cost === undefined || result.usage !== undefined
    ? result
    : { ...result, usage: recordReportedCost({ name, costCaller: caller }, result.cost) };

/** One transcription: the built-in on the agent's model, or the project's own transcriber. */
async function transcribeFile(
  deps: GraphDeps<string>,
  agent: string,
  file: FileContent,
): Promise<TranscriptionResult> {
  const { tenant, signal } = executionOf();
  const options = { signal, tenantId: tenant.tenantId };
  const instance = deps.container.get(FileTranscriber);
  if (instance instanceof ModelFileTranscriber) {
    const binding = deps.registry.fileTranscribers.get(agent);
    if (binding === undefined) throw new TypeError(`${agent}: no transcription model is bound`);
    return instance.transcribeWith(binding, file, options);
  }
  return withReportedCost(
    await instance.transcribe(file, options),
    "files:transcriber",
    "transcriber",
  );
}

/** One redaction: the built-in on the agent's model, or the project's own redactor. */
async function redactFile(
  deps: GraphDeps<string>,
  agent: string,
  settings: ResolvedModelFiles,
  file: FileContent,
  plan: RedactionPlan,
): Promise<RedactionResult> {
  const { tenant, signal } = executionOf();
  // the exact values go to the redaction model only where the providers or the setting allow it (#899 §6)
  const values = valuesForRedactor(settings, plan.values);
  const options = { ...plan, values, signal, tenantId: tenant.tenantId };
  const instance = deps.container.get(FileRedactor);
  if (instance instanceof ModelImageRedactor) {
    const binding = deps.registry.fileRedactors.get(agent);
    if (binding === undefined) throw new TypeError(`${agent}: no redaction model is bound`);
    return instance.redactWith(binding, agent, file, options);
  }
  return withReportedCost(await instance.redact(file, options), "files:redactor", "redactor");
}

/** The agent's file runtime; none when it did not opt in to files. */
export function fileRuntimeOf(
  deps: GraphDeps<string>,
  agent: AgentDefinition,
): FileRuntime | undefined {
  const { files: settings } = agent;
  if (settings === undefined) return undefined;
  return {
    agent: agent.name,
    settings,
    maxResultSize: agent.maxResultSize,
    transcriberKey: () =>
      `${deps.container.get(FileTranscriber).constructor.name}:${settings.transcriptionModel}`,
    redactorKey: () =>
      `${deps.container.get(FileRedactor).constructor.name}:${settings.redactionModel}`,
    supportsRedaction: (mediaType) => deps.container.get(FileRedactor).supports(mediaType),
    threadOwners: () => threadOwnersOf(deps),
    context: () => readContextOf(deps, settings),
    transcribe: (file) => transcribeFile(deps, agent.name, file),
    redact: (file, plan) => redactFile(deps, agent.name, settings, file, plan),
  };
}

/** What the files of an agent's answer are read with (#899 §8): its file runtime and the pass's budgets. */
export interface AnswerFileReading {
  readonly runtime: FileRuntime | undefined;
  readonly budgets: BudgetMeter;
}
