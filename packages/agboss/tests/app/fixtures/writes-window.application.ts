import { Injectable, InMemoryFencedEffectRepository } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { InMemoryCheckpointSaver } from "../../../src/infrastructure/contracts.js";
import { withHoldPoints } from "../../../src/testing/faults/held-stores.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { RecordingLogger } from "../../helpers/log.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import { ChargeWorkflow, FencedExecutionBudget } from "./fenced-effect.workflow.js";

/**
 * #1090 — a holder that loses its lease between a task's `putWrites` and the next checkpoint's
 * `put`: the charge workflow (start, charge, finish) on checkpoint savers with one lever — the
 * n-th `put` never answers (`hangPut`) — and counts of the calls that reached the saver. The graph
 * runs four tasks (the init, the start node, the charge, the finish) and saves a checkpoint before
 * the first and after each of them; counts are of one test's calls, from 1.
 */
export const window: {
  /** The `put` that never answers (0: none). */
  hangPut: number;
  /**
   * A child's own thread cut after its input checkpoint: its first `putWrites` (the hidden start
   * task's) and every `put` of it after that never answer — only the child's input is stored.
   */
  hangChildStart: boolean;
  childStartHung: boolean;
  /** The `putWrites` that never answers (0: none). */
  hangWrite: number;
  writeCalls: number;
  /** The `getTuple` that never answers (0: none). */
  hangGet: number;
  gets: number;
  puts: number;
  writes: number;
} = {
  hangPut: 0,
  hangChildStart: false,
  childStartHung: false,
  hangWrite: 0,
  writeCalls: 0,
  hangGet: 0,
  gets: 0,
  puts: 0,
  writes: 0,
};

export function resetWindow(): void {
  window.hangPut = 0;
  window.hangChildStart = false;
  window.childStartHung = false;
  window.hangWrite = 0;
  window.writeCalls = 0;
  window.hangGet = 0;
  window.gets = 0;
  window.puts = 0;
  window.writes = 0;
}

/** The thread a checkpoint call is about. */
export const threadOf = (config: { readonly configurable?: Record<string, unknown> }): string =>
  String(config.configurable?.thread_id ?? "");

export const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** Counts a `put`; whether it is the one that never answers. */
export const isHungPut = (thread = ""): boolean => {
  window.puts += 1;
  if (window.hangChildStart && window.childStartHung && thread.includes("/child/")) return true;
  return window.puts === window.hangPut;
};

/** Counts a `getTuple`; whether it is the one that never answers. */
export const isHungGet = (): boolean => {
  window.gets += 1;
  return window.gets === window.hangGet;
};

/** Counts a `putWrites`; whether it is the one that never answers. */
export const isHungWrite = (thread = ""): boolean => {
  window.writeCalls += 1;
  if (window.hangChildStart && !window.childStartHung && thread.includes("/child/")) {
    window.childStartHung = true;
    return true;
  }
  return window.writeCalls === window.hangWrite;
};

/** Counts a `putWrites` that was saved. */
export const wroteOne = (): void => {
  window.writes += 1;
};

@Injectable()
export class WindowMemoryCheckpoints extends InMemoryCheckpointSaver {
  override put(...args: Parameters<InMemoryCheckpointSaver["put"]>) {
    if (isHungPut(threadOf(args[0])))
      return never<Awaited<ReturnType<InMemoryCheckpointSaver["put"]>>>();
    return super.put(...args);
  }

  override getTuple(...args: Parameters<InMemoryCheckpointSaver["getTuple"]>) {
    return isHungGet()
      ? never<Awaited<ReturnType<InMemoryCheckpointSaver["getTuple"]>>>()
      : super.getTuple(...args);
  }

  override async putWrites(...args: Parameters<InMemoryCheckpointSaver["putWrites"]>) {
    if (isHungWrite(threadOf(args[0]))) return never<void>();
    await super.putWrites(...args);
    wroteOne();
  }
}

@Application({
  name: "writes-window-memory-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow],
  observers: [RecoveryLog],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, FencedExecutionBudget],
  providers: [
    WindowMemoryCheckpoints,
    withHoldPoints(InMemoryExecutionLeaseRepository),
    RecordingLogger,
    InMemoryFencedEffectRepository,
  ],
})
export class WritesWindowMemoryApplication {}
