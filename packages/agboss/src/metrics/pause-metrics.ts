import type { Counter, Histogram, Meter } from "@opentelemetry/api";
import type { FrameworkLog } from "../infrastructure/logger.js";
import {
  PauseClosedReason,
  PauseResolution,
  type PauseRecord,
} from "../infrastructure/pause-record.js";
import { closedReasonOf } from "../infrastructure/pause-closing.js";
import type { PauseTally } from "../pause/pause-tally.js";
import { counterOf } from "./metrics-observer.js";
import { METRICS } from "./metric-catalog.js";

/**
 * The instance's pause counters (#943): told by the sites that apply a change, once each, on the
 * instance that applied it. Labels are the pause's workflow and its channel's name (bounded by the
 * code) and a close's reason — never an id, a tenant, a thread or anything of the question. A
 * counter that throws is a warning (`metrics.pause-uncounted`), never the pause's failure.
 */

/** The histogram of `time_to_answer`, with its bucket bounds. */
function timeToAnswerOf(meter: Meter): Histogram {
  const { name, unit, description, buckets } = METRICS.pausesTimeToAnswer;
  return meter.createHistogram(name, {
    unit,
    description,
    ...(buckets === undefined ? {} : { advice: { explicitBucketBoundaries: [...buckets] } }),
  });
}

/** Seconds from asked to resolved; `undefined` when either time is missing or unreadable. */
function secondsToAnswer(pause: PauseRecord): number | undefined {
  if (pause.resolvedAt === undefined) return undefined;
  const seconds = (Date.parse(pause.resolvedAt) - Date.parse(pause.askedAt)) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
}

/** The tally on `meter`. */
export function pauseTallyOn(meter: Meter, log: FrameworkLog): PauseTally {
  const opened = counterOf(meter, METRICS.pausesOpened);
  const closed = counterOf(meter, METRICS.pausesClosed);
  const extended = counterOf(meter, METRICS.pausesExtended);
  const notTaken = counterOf(meter, METRICS.pausesAnswersNotTaken);
  const timeToAnswer = timeToAnswerOf(meter);
  const guarded = (count: () => void): void => {
    try {
      count();
    } catch (error) {
      log.warn("metrics.pause-uncounted", `a pause count was not added: ${String(error)}`);
    }
  };
  const labels = (pause: PauseRecord) => ({ workflow: pause.workflow, role: pause.channel });
  const add = (counter: Counter, pause: PauseRecord, extra: Record<string, string> = {}): void => {
    guarded(() => {
      counter.add(1, { ...labels(pause), ...extra });
    });
  };
  return {
    opened: (pause) => {
      add(opened, pause);
    },
    closed: (pause) => {
      const reason = closedReasonOf(pause);
      add(closed, pause, { reason });
      const seconds = secondsToAnswer(pause);
      // a human's answer only: an expiry's decision, a cancel or a channel's own decision are not
      if (reason === PauseClosedReason.Answered && pause.resolution === PauseResolution.Replied)
        guarded(() => {
          if (seconds !== undefined) timeToAnswer.record(seconds, labels(pause));
        });
    },
    extended: (pause) => {
      add(extended, pause);
    },
    answerNotTaken: (pause) => {
      const reason =
        pause.resolution === PauseResolution.TreeEnded
          ? PauseClosedReason.TreeEnded
          : PauseClosedReason.Cancelled;
      add(notTaken, pause, { reason });
    },
  };
}
