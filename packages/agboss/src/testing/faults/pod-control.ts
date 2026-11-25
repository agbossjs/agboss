import {
  FaultChildPauseWorkflowStart,
  FaultTwicePauseWorkflowStart,
} from "./fixture/window.workflow.js";
import type { AnyTenantApp, ExecutionOutput } from "../../app/types.js";
import type { Class } from "../../components/injection.js";
import { ExecutionHistoryRepository } from "../../infrastructure/execution-history.repository.js";
import { waitOf } from "../../infrastructure/clock.js";
import type { FaultBusinessRows } from "./fault-stores.js";
import { FaultExpiringWorkflowStart, FaultPauseWorkflowStart } from "./fixture/pause.workflow.js";
import { FaultBatchWorkflowStart, FaultOrderWorkflowStart } from "./fixture/order.workflow.js";
import type { HeldStoreState } from "./held-stores.js";
import type { HoldPoints } from "./hold-points.js";
import { calledDone, told } from "./pod-calls.js";
import { pauseStateOf } from "./pod-pause-state.js";
import { readStoreClock } from "./store-clock-probe.js";
import type { StoreOutageMode } from "./store-outage.js";
import { FaultPayment, FaultWorkflow, type FaultOrder, type PodCommand } from "./pod-protocol.js";
import type { FaultFacts } from "./facts.js";

/**
 * What a fault pod does with each command of its test (#484): arm, disarm and release holds, start
 * a tree in the background (its end is an event), read the facts the invariants are checked on,
 * cut or restore its stores, close. Every command is answered once it was done: the test's ack.
 */

/** What the commands work on: the pod's app, its holds, its held stores' state and business rows. */
export interface PodParts {
  readonly app: AnyTenantApp;
  readonly points: HoldPoints;
  readonly heldStores: HeldStoreState;
  readonly businessRows: FaultBusinessRows;
}

/** Every record of the history, oldest first, page by page. */
async function historyOf(app: AnyTenantApp): Promise<FaultFacts["records"]> {
  const history = app.resolve(ExecutionHistoryRepository);
  const from = new Date(0);
  const to = new Date("9999-12-31T23:59:59.999Z"); // an ISO text a store compares as text
  const records: FaultFacts["records"][number][] = [];
  let cursor: string | undefined;
  do {
    const page = await history.findAllByStartedAtBetween({ from, to, limit: 100, cursor });
    records.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return records;
}

/** The facts of the run as this pod reads them, every root of `rootExecutionIds` and the history. */
export async function factsOf(
  parts: PodParts,
  rootExecutionIds: readonly string[],
): Promise<FaultFacts> {
  const { app } = parts;
  const records = await historyOf(app);
  const roots = [
    ...new Set([...rootExecutionIds, ...records.map((record) => record.rootExecutionId)]),
  ];
  const trees = await Promise.all(
    roots.map(async (rootExecutionId) => {
      const tree = { tenantId: "default", rootExecutionId };
      const [auditLog, outboundCalls] = await Promise.all([
        app.auditLogOf(tree),
        app.outboundCallsOf(tree),
      ]);
      return { rootExecutionId, auditLog, outboundCalls };
    }),
  );
  return { records, trees, businessRows: await parts.businessRows.committed(app) };
}

/** The fixture's starts of the single-order workflows; another is the order's. */
const STARTS: Partial<Readonly<Record<FaultWorkflow, Class>>> = {
  [FaultWorkflow.Pause]: FaultPauseWorkflowStart,
  [FaultWorkflow.Expiring]: FaultExpiringWorkflowStart,
  [FaultWorkflow.ChildPause]: FaultChildPauseWorkflowStart,
  [FaultWorkflow.TwicePause]: FaultTwicePauseWorkflowStart,
};

const startOf = (workflow: FaultWorkflow): Class => STARTS[workflow] ?? FaultOrderWorkflowStart;

/** The expiring and pause orders have a thread of their own, so a test can cancel it (#941, #1132). */
const OWN_THREAD: readonly FaultWorkflow[] = [FaultWorkflow.Expiring, FaultWorkflow.Pause];
const threadOf = (w: FaultWorkflow, orderId: string): { readonly threadId: string } | undefined =>
  OWN_THREAD.includes(w) ? { threadId: `thread-${orderId}` } : undefined;

/** Starts the tree in the background; its end or its failure is an event. */
function started(
  app: AnyTenantApp,
  tag: string,
  workflow: FaultWorkflow,
  orders: readonly FaultOrder[],
): string {
  const input = orders.map((order) => ({
    orderId: order.orderId,
    decline: order.decline ?? false,
    payment: order.payment ?? FaultPayment.Lookup,
  }));
  const [first = { orderId: "", decline: false, payment: FaultPayment.Lookup }] = input;
  // the fixture's starts, typed by no generated table inside the package
  const execute = app.execute.bind(app) as (
    start: Class,
    value: unknown,
    options?: { readonly threadId: string },
  ) => Promise<ExecutionOutput>;
  const run =
    workflow === FaultWorkflow.Batch
      ? execute(FaultBatchWorkflowStart, input)
      : execute(startOf(workflow), first, threadOf(workflow, first.orderId));
  told(tag, run, "execute-failed");
  return tag;
}

/** A command on the pod's holds (or its own stop), done; `undefined` for another command. */
function holdDone(
  points: HoldPoints,
  command: PodCommand,
): { readonly result: unknown } | undefined {
  switch (command.op) {
    case "arm":
      return { result: points.arm(command.request) };
    case "disarm":
      points.disarm(command.armId);
      return { result: null };
    case "release":
      return { result: points.release(command.holdId) };
    case "release-all":
      points.releaseAll();
      return { result: null };
    case "freeze":
      // between two turns of the event loop, after the reply: no SQLite transaction (synchronous,
      // inside one turn) is open, so the stopped pod holds no database lock a peer would wait for
      setImmediate(() => process.kill(process.pid, "SIGSTOP"));
      return { result: null };
    default:
      return undefined;
  }
}

/** A read of the pod's stores, done (#939, #959); `undefined` for another command. */
function readDone(app: AnyTenantApp, command: PodCommand): Promise<unknown> | undefined {
  switch (command.op) {
    case "pause-state":
      return pauseStateOf(app, command.rootExecutionId);
    case "probe-store-clock":
      return readStoreClock(app, command.wait);
    default:
      return undefined;
  }
}

/** Begins the store outage of `mode`, or ends it (`null`). */
function outageSet(parts: PodParts, mode: StoreOutageMode | null): null {
  if (mode === null) parts.heldStores.outage.end();
  else parts.heldStores.outage.begin(mode);
  return null;
}

/** Does `command` and gives what its reply carries. */
export async function commandDone(parts: PodParts, command: PodCommand): Promise<unknown> {
  const held = holdDone(parts.points, command);
  if (held !== undefined) return held.result;
  const read = readDone(parts.app, command);
  if (read !== undefined) return read;
  const called = calledDone(parts.app, command);
  if (called !== undefined) return called;
  switch (command.op) {
    case "start":
      return started(parts.app, command.tag, command.workflow, command.orders);
    case "read":
      return factsOf(parts, command.rootExecutionIds);
    case "outage":
      return outageSet(parts, command.mode);
    case "close":
      await parts.app.close(
        command.timeout === undefined ? {} : { timeout: waitOf(command.timeout) },
      );
      return null;
    default:
      return null;
  }
}
