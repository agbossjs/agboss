// #824 — the server's parts for unit tests of its modules (mutation shard `a2a-server`): the
// in-memory task store, a scripted execution control and app, this process's runs, a virtual clock
// and counted ids — every call recorded.
import { InMemoryA2ADirectMessageRepository } from "../../../../src/infrastructure/in-memory-a2a-direct-message.repository.js";
import { InMemoryCostLedgerRepository } from "../../../../src/infrastructure/cost-ledger.repository.js";
import { A2AReply } from "../../../../src/a2a/a2a-expose.decorator.js";
import { InlineA2AFileRepository } from "../../../../src/infrastructure/a2a-file.repository.js";
import { seconds } from "../../../../src/units/index.js";
import { DEFAULT_A2A_FILE_LIMITS } from "../../../../src/a2a/files/a2a-file-options.js";
import { Role, type Message } from "@a2a-js/sdk";
import { dataPart, textPart } from "../../../../src/a2a/server/a2a-task-view.js";
import { A2AOperation } from "../../../../src/a2a/a2a-caller.js";
import type {
  A2ARequestCaller,
  A2AServerParts,
} from "../../../../src/a2a/server/a2a-server-parts.js";
import { LocalRuns } from "../../../../src/a2a/server/a2a-local-runs.js";
import { A2AMediaType, type ServedSkill } from "../../../../src/a2a/server/a2a-skills.js";
import {
  DurableExecutionStatus,
  ExecutionCancelOutcome,
  type DurableExecutionState,
} from "../../../../src/app/execution-control.js";
import { WorkflowStartTextDto } from "../../../../src/dto/standard/framework.js";
import {
  A2ATaskSaveStatus,
  A2ATaskState,
  type A2ATaskRecord,
  type A2ATaskStatus,
  type NewA2ATask,
} from "../../../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ATaskRepository } from "../../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../../../src/testing/clock.js";
import type { A2ARequestMesh } from "../../../../src/a2a/server/a2a-mesh-admission.js";
import type { MeshSettings } from "../../../../src/mesh/mesh-settings.js";

/** A request that carried no envelope (#810). */
export const NO_MESH: A2ARequestMesh = {
  envelope: undefined,
  trusted: undefined,
  traceparent: undefined,
};

export const NINE = new Date("2026-01-05T09:00:00.000Z");

/** The served application's mesh settings: its name, its hop limit, no keys. */
export const UNIT_MESH: MeshSettings = {
  application: "unit-application",
  maxMeshHops: 8,
  keys: { peers: new Map() },
  clock: new VirtualClock(NINE),
  idempotencyRetention: 0,
  a2aTaskRetention: 0,
  a2aFileRetention: 0,
  a2aMessageRetention: 0,
  a2aFiles: undefined,
  workflows: [],
  exposes: [],
  contracts: () => Promise.reject(new Error("no contracts in a unit test")),
};
export const SUBMITTED: A2ATaskStatus = { state: A2ATaskState.Submitted, pendingPauses: [] };
export const WORKING: A2ATaskStatus = { state: A2ATaskState.Working, pendingPauses: [] };

/** The one start the unit tests serve: a text skill. */
export class UnitWorkflowStart {
  readonly role = "a unit start";
}

export const TEXT_SKILL: ServedSkill = {
  id: "unit-workflow-start",
  start: UnitWorkflowStart,
  description: "a unit start",
  input: WorkflowStartTextDto,
  inputMediaType: A2AMediaType.Text,
  inputSchema: null,
  inputSchemaHash: null,
  outputs: [
    {
      finish: "unit-workflow-finish",
      mediaType: A2AMediaType.Json,
      schema: null,
      fileFields: [],
      hasData: true,
    },
  ],
  inputFiles: [],
  fileLimits: DEFAULT_A2A_FILE_LIMITS,
  outputFileMediaTypes: DEFAULT_A2A_FILE_LIMITS.allowedMediaTypes,
  reply: A2AReply.Task,
  callsModel: false,
};

/** What the scripted control and app were asked, and what they answer. */
export interface Script {
  state: DurableExecutionState;
  cancel: ExecutionCancelOutcome;
  claims: boolean;
  /** What `app.execute` / `app.resume` do: resolve, or reject with this. */
  runError?: Error;
  /** Holds every run until released. */
  hold?: Promise<void>;
  readonly calls: string[];
  readonly executions: {
    readonly start: unknown;
    readonly input: unknown;
    readonly options: Record<string, unknown>;
  }[];
  readonly resumes: { readonly request: unknown; readonly options: Record<string, unknown> }[];
  readonly warnings: string[];
  readonly errors: string[];
}

export function scriptOf(overrides: Partial<Script> = {}): Script {
  return {
    state: { status: DurableExecutionStatus.Running },
    cancel: ExecutionCancelOutcome.Requested,
    claims: true,
    calls: [],
    executions: [],
    resumes: [],
    warnings: [],
    errors: [],
    ...overrides,
  };
}

let minted = 0;

/** The parts over `tasks`, scripted by `script`. */
export function unitParts(
  script: Script,
  tasks: InMemoryA2ATaskRepository = new InMemoryA2ATaskRepository(new InMemoryDatabase()),
  extra: Partial<A2AServerParts> = {},
): A2AServerParts {
  const run = async (): Promise<unknown> => {
    await script.hold;
    if (script.runError !== undefined) throw script.runError;
    return {};
  };
  const parts: Partial<A2AServerParts> = {
    tasks,
    clock: new VirtualClock(NINE),
    runs: new LocalRuns(),
    skills: [TEXT_SKILL],
    maxTaskDuration: undefined,
    mesh: UNIT_MESH,
    files: { store: new InlineA2AFileRepository(), transport: undefined, timeout: seconds(10) },
    // #860: no direct-reply skill here, no default skill
    direct: {
      messages: new InMemoryA2ADirectMessageRepository(new InMemoryDatabase()),
      ledger: new InMemoryCostLedgerRepository(),
      defaultSkill: undefined,
    },
    ids: {
      newExecutionId: () => {
        const id = `minted-${String((minted += 1))}`;
        script.calls.push(`mint ${id}`);
        return id;
      },
      newThreadId: () => "minted-thread",
    },
    control: {
      executionStateOf: (tree) => {
        script.calls.push(`state ${tree.rootExecutionId}`);
        return Promise.resolve(script.state);
      },
      cancelExecution: (request) => {
        script.calls.push(`cancel ${request.rootExecutionId} ${String(request.ownerId)}`);
        return Promise.resolve(script.cancel);
      },
      claimExecutionId: (identity) => {
        script.calls.push(`claim ${identity.executionId}`);
        return Promise.resolve(script.claims);
      },
    },
    // the app's execute and resume, recorded: the members the server calls
    app: {
      execute: ((start: unknown, input: unknown, options: Record<string, unknown>) => {
        script.executions.push({ start, input, options });
        return run();
      }) as never,
      resume: ((request: unknown, options: Record<string, unknown>) => {
        script.resumes.push({ request, options });
        return run();
      }) as never,
      cancel: () => Promise.reject(new Error("not used")),
      resolve: (() => undefined) as never,
    },
    log: {
      info: () => undefined,
      warn: (code: string, message: string, subject?: unknown) => {
        script.warnings.push(`${code} ${message} ${JSON.stringify(subject)}`);
      },
      error: (code: string, message: string, subject?: unknown) => {
        script.errors.push(`${code} ${message} ${JSON.stringify(subject)}`);
      },
    },
    ...extra,
  };
  // what the server's modules use of the parts, every member given
  return parts as A2AServerParts;
}

/** A caller of tenant `acme`, owner `dana` (or another), admitted for `operation`. */
export const callerOf = (
  overrides: Partial<A2ARequestCaller> = {},
  operation: A2AOperation = A2AOperation.SendMessage,
): A2ARequestCaller => ({
  caller: { ownerId: "dana" },
  tenantId: "acme",
  ownerId: "dana",
  signal: new AbortController().signal,
  admitted: { operation, taskId: "" },
  mesh: NO_MESH,
  ...overrides,
});

/** A task of dana's in `tasks`, saved as `status` (then written to it, if not submitted). */
export async function savedTask(
  tasks: InMemoryA2ATaskRepository,
  overrides: Partial<NewA2ATask> = {},
  status: A2ATaskStatus = SUBMITTED,
): Promise<A2ATaskRecord> {
  const save = await tasks.saveIfAbsent({
    tenantId: "acme",
    taskId: "task-1",
    ownerId: "dana",
    contextId: "ctx-1",
    skill: TEXT_SKILL.id,
    status: SUBMITTED,
    acceptedAt: NINE,
    messageId: "m-1",
    requestHash: "h",
    ...overrides,
  });
  if (save.status !== A2ATaskSaveStatus.Saved) throw new Error(save.status);
  if (status.state === A2ATaskState.Submitted) return save.task;
  const written = await tasks.compareAndSetStatus(save.task, 1, status, NINE);
  if (written === undefined) throw new Error("not written");
  return written;
}

/** What a promise rejected with: its error's name and its metadata code, or "resolved". */
export const refusalOf = (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => "resolved",
    (error: unknown) => {
      const { name, metadata, message } = error as {
        name: string;
        message: string;
        metadata?: { code?: string };
      };
      return `${name}${metadata?.code === undefined ? "" : ` ${metadata.code}`}: ${message}`;
    },
  );

/** A user message's decoded form: text parts, the context and task it names. */
export const messageOf = (
  messageId: string,
  texts: readonly string[],
  fields: { readonly contextId?: string; readonly taskId?: string; readonly data?: unknown } = {},
): Message => ({
  messageId,
  contextId: fields.contextId ?? "",
  taskId: fields.taskId ?? "",
  role: Role.ROLE_USER,
  parts: [
    ...texts.map((text) => textPart(text)),
    ...(fields.data === undefined ? [] : [dataPart(fields.data)]),
  ],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});

/** Lets every pending callback of resolved promises run. */
export const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};
