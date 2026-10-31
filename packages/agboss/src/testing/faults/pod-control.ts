import type { App, ExecutionOutput } from "../../app/types.js";
import type { Class } from "../../components/injection.js";
import { ExecutionHistoryRepository } from "../../infrastructure/execution-history.repository.js";
import { waitOf } from "../../infrastructure/clock.js";
import type { FaultBusinessRows } from "./fault-stores.js";
import { FaultBatchWorkflowStart, FaultOrderWorkflowStart } from "./fixture/order.workflow.js";
import { sendToTest } from "./fixture/pod-link.js";
import type { HeldStoreSeam } from "./held-stores.js";
import type { HoldPoints } from "./hold-points.js";
import { FaultWorkflow, type FaultOrder, type PodCommand } from "./pod-protocol.js";
import type { FaultFacts } from "./facts.js";

/**
 * What a fault pod does with each command of its test (#484): arm, disarm and release holds, start
 * a tree in the background (its end is an event), read the facts the invariants are checked on,
 * cut or restore its stores, close. Every command is answered once it was done: the test's ack.
 */

/** What the commands work on: the pod's app, its holds, its stores' seam and business rows. */
export interface PodParts {
  readonly app: App;
  readonly points: HoldPoints;
  readonly seam: HeldStoreSeam;
  readonly businessRows: FaultBusinessRows;
}

/** Every record of the history, oldest first, page by page. */
async function historyOf(app: App): Promise<FaultFacts["records"]> {
  const history = app.resolve(ExecutionHistoryRepository);
  const from = new Date(0);
  const to = new Date("9999-12-31T23:59:59.999Z"); // an ISO text a store compares as text
  const records: FaultFacts["records"][number][] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await history.findAllByStartedAtBetween(from, to, { offset, limit: 100 });
    records.push(...page);
    if (page.length < 100) return records;
  }
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
      const [leaseEvents, outboundCalls] = await Promise.all([
        app.leaseEventsOf(tree),
        app.outboundCallsOf(tree),
      ]);
      return { rootExecutionId, leaseEvents, outboundCalls };
    }),
  );
  return { records, trees, businessRows: await parts.businessRows.committed(app) };
}

/** What a test reads of a finished `execute`. */
const outcomeOf = (done: ExecutionOutput) => ({
  status: done.status,
  executionId: done.executionId,
  output: done.output,
  finish: done.finish?.name,
});

/** Starts the tree in the background; its end or its failure is an event. */
function started(
  app: App,
  tag: string,
  workflow: FaultWorkflow,
  orders: readonly FaultOrder[],
): string {
  const input = orders.map((order) => ({
    orderId: order.orderId,
    decline: order.decline ?? false,
  }));
  const [first = { orderId: "", decline: false }] = input;
  // the fixture's starts, typed by no generated table inside the package
  const execute = app.execute.bind(app) as (
    start: Class,
    value: unknown,
  ) => Promise<ExecutionOutput>;
  const run =
    workflow === FaultWorkflow.Batch
      ? execute(FaultBatchWorkflowStart, input)
      : execute(FaultOrderWorkflowStart, first);
  run.then(
    (done) => {
      sendToTest({ kind: "event", event: { type: "finished", tag, ...outcomeOf(done) } });
    },
    (error: unknown) => {
      const name = error instanceof Error ? error.name : typeof error;
      sendToTest({
        kind: "event",
        event: { type: "execute-failed", tag, error: name, message: String(error) },
      });
    },
  );
  return tag;
}

/** A command on the pod's holds, done; `undefined` for another command. */
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
    default:
      return undefined;
  }
}

/** Does `command` and gives what its reply carries. */
export async function commandDone(parts: PodParts, command: PodCommand): Promise<unknown> {
  const held = holdDone(parts.points, command);
  if (held !== undefined) return held.result;
  switch (command.op) {
    case "start":
      return started(parts.app, command.tag, command.workflow, command.orders);
    case "read":
      return factsOf(parts, command.rootExecutionIds);
    case "outage":
      if (command.mode === null) parts.seam.outage.end();
      else parts.seam.outage.begin(command.mode);
      return null;
    case "close":
      await parts.app.close(
        command.timeout === undefined ? {} : { timeout: waitOf(command.timeout) },
      );
      return null;
    default:
      return null;
  }
}
