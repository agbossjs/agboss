// #860 — the server's parts for unit tests of the direct replies (mutation shard `a2a-direct`):
// the unit parts of the server (an in-memory direct store, a virtual clock) with a direct skill, an
// app whose every run is recorded and scripted, and attempt ids counted per rig.
import { A2AReply } from "../../../../src/a2a/a2a-expose.decorator.js";
import type { A2AServerParts } from "../../../../src/a2a/server/a2a-server-parts.js";
import type { ServedSkill } from "../../../../src/a2a/server/a2a-skills.js";
import { ExecutionStatus, type ExecutionOutput } from "../../../../src/app/types.js";
import { buildCostReport } from "../../../../src/finops/usage.js";
import { bareRecordOf, ComponentKind } from "../../../../src/flow/runtime/records.js";
import {
  A2ADirectMessageState,
  type A2ADirectMessageRecord,
  type NewA2ADirectMessage,
} from "../../../../src/infrastructure/a2a-direct-message.repository.js";
import type { InMemoryA2ADirectMessageRepository } from "../../../../src/infrastructure/in-memory-a2a-direct-message.repository.js";
import type { VirtualClock } from "../../../../src/testing/clock.js";
import { seconds } from "../../../../src/units/index.js";
import { NINE, scriptOf, TEXT_SKILL, unitParts } from "../../server/support/unit-parts.js";

/** The unit start as a direct-reply skill that can call a model. */
export const DIRECT_SKILL: ServedSkill = {
  ...TEXT_SKILL,
  reply: A2AReply.Message,
  callsModel: true,
};

/** Dana's message `m-1` of tenant `acme`. */
export const KEY = { tenantId: "acme", ownerId: "dana", messageId: "m-1" } as const;

/** What every finished run returns: the unit finish, its output, what it spent. */
export const OUTPUT = { total: 3 };

export const finished = (): ExecutionOutput => ({
  status: ExecutionStatus.Finished,
  threadId: "thread",
  tenantId: "acme",
  executionId: "run",
  finish: bareRecordOf("unit-workflow-finish", ComponentKind.WorkflowFinish),
  output: OUTPUT,
  pending: [],
  path: [],
  spend: { ...buildCostReport([]), totalUsd: 0.25 },
  launches: [],
  children: [],
  handledErrors: [],
  compensations: [],
  toolCalls: [],
});

/** One run the app was asked for. */
export interface RecordedRun {
  readonly input: unknown;
  readonly options: Record<string, unknown> & { readonly signal: AbortSignal };
}

/** What a run does: by default it finishes at once. */
export type RunScript = (run: RecordedRun) => Promise<ExecutionOutput>;

export interface DirectRig {
  readonly parts: A2AServerParts;
  readonly messages: InMemoryA2ADirectMessageRepository;
  readonly clock: VirtualClock;
  readonly runs: RecordedRun[];
  /** Replaces what the next runs do. */
  script: RunScript;
}

/** The direct parts: `extra` over the unit parts, attempts `attempt-1`, `attempt-2`, … */
export function directRig(extra: Partial<A2AServerParts> = {}): DirectRig {
  let made = 0;
  const runs: RecordedRun[] = [];
  let script: RunScript = () => Promise.resolve(finished());
  const base = unitParts(scriptOf());
  const parts = unitParts(scriptOf(), undefined, {
    skills: [DIRECT_SKILL],
    ids: {
      newExecutionId: () => `attempt-${String((made += 1))}`,
      newThreadId: () => "thread-1",
    },
    app: {
      ...base.app,
      execute: ((_start: unknown, input: unknown, options: RecordedRun["options"]) => {
        const run = { input, options };
        runs.push(run);
        return script(run);
      }) as never,
    },
    ...extra,
  });
  return {
    parts,
    messages: parts.direct.messages as InMemoryA2ADirectMessageRepository,
    clock: parts.clock as VirtualClock,
    runs,
    get script() {
      return script;
    },
    set script(next: RunScript) {
      script = next;
    },
  };
}

/** A message as another call accepted it: in flight under `run-lost` until 30 s past nine. */
export const acceptedMessage = (
  overrides: Partial<NewA2ADirectMessage> = {},
): NewA2ADirectMessage => ({
  ...KEY,
  requestHash: "h-1",
  skill: DIRECT_SKILL.id,
  contextId: "ctx-1",
  attemptId: "run-lost",
  startedAt: NINE,
  expiresAt: new Date(NINE.getTime() + seconds(30)),
  callsModel: true,
  createdAt: NINE,
  ...overrides,
});

/** `message` as the store keeps it in flight. */
export const inFlight = (message: NewA2ADirectMessage): A2ADirectMessageRecord => ({
  ...message,
  state: A2ADirectMessageState.InFlight,
});

/** Whether `promise` settled yet, read at once. */
export function watched<T>(promise: Promise<T>): { readonly settled: () => boolean } {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  return { settled: () => settled };
}

/** A gate a run waits at until it is opened. */
export function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}
