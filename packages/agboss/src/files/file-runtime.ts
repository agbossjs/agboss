import { DEFAULT_FILE_FETCH_TIMEOUT } from "../a2a/files/a2a-file-options.js";
import type { FileTransport } from "../a2a/files/a2a-file-transport.js";
import { currentFrame, rootFactsOf } from "../flow/context/frame.js";
import { A2AFileRepository } from "../infrastructure/a2a-file.repository.js";
import { lazyLoad, systemClock } from "../infrastructure/clock.js";
import type { BudgetMeter } from "../budgets/execution-budgets.js";
import { recordReportedCost } from "../finops/usage.js";
import type { AgentDefinition } from "../graph/agent-loop/deps.js";
import type { GraphDeps } from "../graph/deps.js";
import { contextMeshSettingsOf } from "../mesh/mesh-settings.js";
import { kilobytes } from "../units/index.js";
import type { FileReadContext } from "./file-bytes.js";
import { FileTranscriber, ModelFileTranscriber } from "./file-transcriber.js";
import type { FileRuntime } from "./visit-files.js";

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

/** The agent's file runtime; none when it did not opt in to files. */
export function fileRuntimeOf(
  deps: GraphDeps<string>,
  agent: AgentDefinition,
): FileRuntime | undefined {
  const { files: settings } = agent;
  if (settings === undefined) return undefined;
  const transcriber = (): FileTranscriber => deps.container.get(FileTranscriber);
  return {
    agent: agent.name,
    settings,
    maxResultSize: agent.maxResultSize,
    transcriberKey: () => `${transcriber().constructor.name}:${settings.transcriptionModel}`,
    context: (): FileReadContext => {
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
    },
    transcribe: async (file) => {
      const { tenant, signal } = executionOf();
      const options = { signal, tenantId: tenant.tenantId };
      const instance = transcriber();
      if (instance instanceof ModelFileTranscriber) {
        const binding = deps.registry.fileTranscribers.get(agent.name);
        if (binding === undefined)
          throw new TypeError(`${agent.name}: no transcription model is bound`);
        return instance.transcribeWith(binding, file, options);
      }
      const result = await instance.transcribe(file, options);
      return result.cost === undefined || result.usage !== undefined
        ? result
        : {
            ...result,
            usage: recordReportedCost(
              { name: "transcriber", costCaller: "files:transcriber" },
              result.cost,
            ),
          };
    },
  };
}

/** What the files of an agent's answer are read with (#899 §8): its file runtime and the pass's budgets. */
export interface AnswerFileReading {
  readonly runtime: FileRuntime | undefined;
  readonly budgets: BudgetMeter;
}
