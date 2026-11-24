/**
 * #1366: the paused-execution contract's fixtures (a paused run, an approval's pause, a question's
 * pause, the kind-only pauses) are values the cases rely on: a store that forgets one of them —
 * reads a field back blank, or drops the pauses of a tree — fails the case that writes it and reads
 * it back, and that case still fails when the fixture itself is blank only because the case reads it.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../../../src/infrastructure/in-memory-paused-execution.repository.js";
import type { PausedExecution } from "../../../../src/app/paused-runs.js";
import { PauseKind } from "../../../../src/infrastructure/pause-record.js";
import type { PauseRecord } from "../../../../src/infrastructure/paused-execution.repository.js";
import type { ContractCase, ContractGroup } from "../../../../src/testing/contracts/define.js";
import { withTarget } from "../../../../src/testing/contracts/instance-context.js";
import type { ContractTarget } from "../../../../src/testing/contracts/instance-context.js";
import { inMemoryTarget } from "../../../infrastructure/contracts/store-kinds.js";

const captured = vi.hoisted(() => ({
  groups: [] as ContractGroup<InMemoryPausedExecutionRepository>[],
}));

vi.mock("../../../../src/testing/contracts/define.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../../src/testing/contracts/define.js")>();
  return {
    ...original,
    registerContract: (_contract: string, _target: unknown, groups: never) => {
      captured.groups.push(...(groups as ContractGroup<InMemoryPausedExecutionRepository>[]));
    },
  };
});

const { pausedExecutionContract } =
  await import("../../../../src/testing/contracts/paused-execution.contract.js");
pausedExecutionContract(inMemoryTarget(() => new InMemoryPausedExecutionRepository()));
const CASES: readonly ContractCase<InMemoryPausedExecutionRepository>[] = captured.groups.flatMap(
  (group) => group.cases.filter((one) => one.capability === undefined && one.isFencing !== true),
);

const BY_THREAD = "a saved pause is found on the other instance as written, its versions with it";
const STEP_KEY =
  "a step's second try finds the first pause, with its id — on the other instance too";
const QUESTION =
  "#746: a question's pause is found on the other instance as written — by id and by its tree";
const KIND = "0.1.1: a pause's kind is kept as written — never inferred from its component";

/** What a store forgets of what it keeps. */
interface Loss {
  readonly run?: (run: PausedExecution) => PausedExecution;
  readonly pause?: (pause: PauseRecord) => PauseRecord;
  readonly tree?: (pauses: readonly PauseRecord[]) => PauseRecord[];
}

class Forgetful extends InMemoryPausedExecutionRepository {
  constructor(private readonly loss: Loss) {
    super();
  }
  override async findByTenantIdAndThreadId(tenantId: string, threadId: string) {
    const found = await super.findByTenantIdAndThreadId(tenantId, threadId);
    return found === undefined || this.loss.run === undefined ? found : this.loss.run(found);
  }
  override async findOrCreateByStepKey(pause: PauseRecord) {
    const found = await super.findOrCreateByStepKey(pause);
    return this.loss.pause === undefined ? found : this.loss.pause(found);
  }
  override async findByTenantIdAndPauseId(tenantId: string, pauseId: string) {
    const found = await super.findByTenantIdAndPauseId(tenantId, pauseId);
    return found === undefined || this.loss.pause === undefined ? found : this.loss.pause(found);
  }
  override async findAllByTenantIdAndRootExecutionId(tenantId: string, rootExecutionId: string) {
    const found = await super.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId);
    if (this.loss.tree !== undefined) return this.loss.tree(found);
    return this.loss.pause === undefined ? found : found.map(this.loss.pause);
  }
}

async function failedWith(loss: Loss): Promise<string[]> {
  const failed: string[] = [];
  for (const one of CASES) {
    const store = new Forgetful(loss);
    const target: ContractTarget<InMemoryPausedExecutionRepository> = {
      name: "forgetful",
      instance: () => store,
    };
    try {
      await withTarget(target, one.run, one.databaseTime)();
    } catch {
      failed.push(one.name);
    }
  }
  return failed;
}

const blank = <T extends object>(value: T, key: string): T => ({ ...value, [key]: "" });
const blankValues = (value: object): object =>
  Object.fromEntries(Object.keys(value).map((key) => [key, ""]));
const withRun =
  (change: (run: PausedExecution["run"]) => PausedExecution["run"]) =>
  (paused: PausedExecution): PausedExecution => ({ ...paused, run: change(paused.run) });
const withAsk =
  (change: (ask: Record<string, unknown>) => Record<string, unknown>) =>
  (pause: PauseRecord): PauseRecord =>
    pause.toolCall !== undefined
      ? {
          ...pause,
          input: change(Object.fromEntries(Object.entries(pause.input))),
        }
      : pause;

const LOSSES: readonly (readonly [string, Loss, string])[] = [
  ["turn id", { run: withRun((run) => blank(run, "turnId")) }, BY_THREAD],
  ["start", { run: withRun((run) => blank(run, "start")) }, BY_THREAD],
  [
    "start input",
    { run: withRun((run) => ({ ...run, startInput: blankValues(run.startInput as object) })) },
    BY_THREAD,
  ],
  ["path emptied", { run: withRun((run) => ({ ...run, path: [] })) }, BY_THREAD],
  [
    "path first",
    { run: withRun((run) => ({ ...run, path: ["", ...run.path.slice(1)] })) },
    BY_THREAD,
  ],
  [
    "path second",
    { run: withRun((run) => ({ ...run, path: run.path.map((one, at) => (at === 1 ? "" : one)) })) },
    BY_THREAD,
  ],
  ["workflow version", { run: (paused) => blank(paused, "workflowVersion") }, BY_THREAD],
  ["config hash", { run: (paused) => blank(paused, "configHash") }, BY_THREAD],
  ["thread id of a pause", { pause: (pause) => blank(pause, "threadId") }, STEP_KEY],
  [
    "node of a pause",
    { pause: (pause) => (pause.kind === PauseKind.Approval ? blank(pause, "nodeId") : pause) },
    STEP_KEY,
  ],
  ["step of a pause", { pause: (pause) => blank(pause, "step") }, STEP_KEY],
  ["call id of the ask", { pause: withAsk((ask) => blank(ask, "callId")) }, STEP_KEY],
  ["tool of the ask", { pause: withAsk((ask) => blank(ask, "tool")) }, STEP_KEY],
  [
    "arguments of the ask",
    { pause: withAsk((ask) => ({ ...ask, arguments: blankValues(ask.arguments as object) })) },
    STEP_KEY,
  ],
  ["summary of the ask", { pause: withAsk((ask) => blank(ask, "summary")) }, STEP_KEY],
  [
    "step key of a question",
    { pause: (pause) => (pause.kind === PauseKind.ExternalTask ? blank(pause, "stepKey") : pause) },
    QUESTION,
  ],
  [
    "node of a question",
    { pause: (pause) => (pause.kind === PauseKind.ExternalTask ? blank(pause, "nodeId") : pause) },
    QUESTION,
  ],
  [
    "channel of a question",
    { pause: (pause) => (pause.kind === PauseKind.ExternalTask ? blank(pause, "channel") : pause) },
    QUESTION,
  ],
  [
    "component name",
    {
      pause: (pause) =>
        pause.component === undefined
          ? pause
          : { ...pause, component: blank(pause.component, "name") },
    },
    QUESTION,
  ],
  [
    "component name, kind-only",
    {
      pause: (pause) =>
        pause.component === undefined
          ? pause
          : { ...pause, component: blank(pause.component, "name") },
    },
    KIND,
  ],
  ["the tree's pauses", { tree: () => [] }, KIND],
];

describe("#1366: the paused-execution fixtures", () => {
  it("the cases pass on the sound store", async () => {
    expect(await failedWith({})).toEqual([]);
  });

  for (const [what, loss, name] of LOSSES) {
    it(`a store that forgets the ${what} fails: ${name.slice(0, 40)}`, async () => {
      expect(await failedWith(loss)).toContain(name);
    });
  }
});
