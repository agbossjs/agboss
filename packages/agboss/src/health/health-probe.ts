import type { Clock } from "../infrastructure/clock.js";
import { timeoutOn, waitOf } from "../infrastructure/clock.js";
import type { Milliseconds } from "../units/index.js";
import {
  HealthStatus,
  type HealthComponentKind,
  type HealthComponentReport,
} from "./health-check.js";

/**
 * One component's check under its timeout on the application's `Clock` (#300): a check that
 * throws or passes its timeout is that component's `Unhealthy`, its reason the error's message or
 * `timed out after 2 s` — a probe never rejects.
 */

/** What a check found: its status and, unless healthy, why. */
export interface ProbeOutcome {
  readonly status: HealthStatus;
  readonly reason?: string;
}

/** The component a check is about, and how long it may take. */
export interface ProbedComponent {
  readonly name: string;
  readonly kind: HealthComponentKind;
  readonly timeout: Milliseconds;
}

/** The reason of a check past its timeout: `timed out after 2 s`. */
export const timedOutReason = (timeout: Milliseconds): string =>
  `timed out after ${String(timeout / 1000)} s`;

const unhealthy = (reason: string): ProbeOutcome => ({ status: HealthStatus.Unhealthy, reason });

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The component's report: its outcome and how long it took. */
export const componentReportOf = (
  component: Pick<ProbedComponent, "name" | "kind">,
  outcome: ProbeOutcome,
  duration: Milliseconds,
): HealthComponentReport => ({
  name: component.name,
  kind: component.kind,
  status: outcome.status,
  ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  duration,
});

/** The check's outcome, or `Unhealthy` when it throws or its timeout passes first. */
async function outcomeOf(
  timeout: Milliseconds,
  clock: Clock,
  check: () => Promise<ProbeOutcome>,
): Promise<ProbeOutcome> {
  const reason = timedOutReason(timeout);
  const timer = timeoutOn(clock, timeout, () => new Error(reason));
  const timedOut = new Promise<ProbeOutcome>((resolve) => {
    timer.signal.addEventListener(
      "abort",
      () => {
        resolve(unhealthy(reason));
      },
      { once: true },
    );
  });
  // a check that throws synchronously is a rejected one
  const checked = Promise.resolve()
    .then(check)
    .catch((error: unknown) => unhealthy(messageOf(error)));
  try {
    return await Promise.race([checked, timedOut]);
  } finally {
    timer.release();
  }
}

/** Runs one component's check: its report, never a rejection. */
export async function probe(
  component: ProbedComponent,
  clock: Clock,
  check: () => Promise<ProbeOutcome>,
): Promise<HealthComponentReport> {
  const startedAt = clock.now().getTime();
  const outcome = await outcomeOf(component.timeout, clock, check);
  return componentReportOf(component, outcome, waitOf(clock.now().getTime() - startedAt));
}
