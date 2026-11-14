import { ExecutionHistoryStatus } from "../../../infrastructure/execution-history.repository.js";
import { pauseKeyOf } from "../../../infrastructure/pause-record.js";
import type { FaultRun } from "../facts.js";
import { FaultInvariant, violation, type FaultViolation } from "./violations.js";

/**
 * Notices once each, in order (#940, invariant `notices-once-each-in-order`): every pause of an
 * ended tree — one a rest told the test of, or one the tree's record lists — has been told to the
 * fixture's listener: exactly one `opened` and exactly one `closed`, the `opened` first; a notice
 * heard more than once (a delivery whose ack a crash lost) carries the same `deliveryId` every time.
 * Never zero times: a pod killed between the close and its notice, or between the notice and its
 * delivery, leaves the notice to another pod.
 */

/** What the fixture's listener told the test of one delivery. */
interface Heard {
  readonly notice: string;
  readonly deliveryId: string;
}

/** The pauses of an ended tree: the ids a rest listed, and the ones its record lists. */
function pausesOf(run: FaultRun): readonly { readonly key: string; readonly root: string }[] {
  const ended = run.records.filter((record) => record.status !== ExecutionHistoryStatus.Paused);
  return ended.flatMap((record) => {
    const rested = run.events
      .filter((event) => event.type === "finished" && event.executionId === record.executionId)
      .flatMap((event) => (Array.isArray(event.pauseIds) ? event.pauseIds.map(String) : []));
    const logged = record.pauses.flatMap((pause) =>
      pause.pauseId === undefined ? [] : [pause.pauseId],
    );
    return [...new Set([...rested, ...logged])].map((pauseId) => ({
      key: pauseKeyOf(record.tenantId, pauseId),
      root: record.executionId,
    }));
  });
}

/** The deliveries the listener told of the pause, in the order the test heard them. */
const heardOf = (run: FaultRun, key: string): readonly Heard[] =>
  run.events
    .filter((event) => event.type === "pause-notice" && event.pauseKey === key)
    .map((event) => ({ notice: String(event.notice), deliveryId: String(event.deliveryId) }));

function noticeViolationsOf(
  pause: { key: string; root: string },
  heard: readonly Heard[],
): string[] {
  const found: string[] = [];
  for (const notice of ["opened", "closed"]) {
    const ids = new Set(heard.filter((one) => one.notice === notice).map((one) => one.deliveryId));
    if (ids.size === 0) found.push(`pause ${pause.key} of ${pause.root} was never told ${notice}`);
    if (ids.size > 1)
      found.push(
        `pause ${pause.key} was told ${notice} under ${String(ids.size)} deliveryIds, one expected`,
      );
  }
  const firstClosed = heard.findIndex((one) => one.notice === "closed");
  const firstOpened = heard.findIndex((one) => one.notice === "opened");
  if (firstClosed >= 0 && firstOpened > firstClosed)
    found.push(`pause ${pause.key} was told closed before opened`);
  return found;
}

/** Every pause of an ended tree told exactly once under one id each, opened first. */
export function pauseNoticeViolations(run: FaultRun): FaultViolation[] {
  return pausesOf(run).flatMap((pause) =>
    noticeViolationsOf(pause, heardOf(run, pause.key)).map((message) =>
      violation(FaultInvariant.NoticesOnceEachInOrder, message),
    ),
  );
}
