import { SWEEP_EVERY } from "../infrastructure/recovery.js";
import { waitOf } from "../infrastructure/clock.js";
import { componentReportOf, type ProbeOutcome } from "./health-probe.js";
import {
  HealthComponentKind,
  HealthStatus,
  type HealthComponentReport,
  type HealthReport,
} from "./health-check.js";
import type { ApplicationHealth, HealthSources } from "./health-sources.js";
import { readinessProbes } from "./readiness-checks.js";

/**
 * The probes of an application instance (#300), loaded on first use. Liveness reads only what the
 * instance knows itself — whether it is stopping, when its recovery loop last ended a sweep —
 * readiness adds the checks that reach outside (`readiness-checks.ts`). Both resolve with the
 * report, whatever a check does.
 */

/** A sweep that ended longer ago than this is stuck: three sweep intervals. */
export const STUCK_AFTER = waitOf(SWEEP_EVERY * 3);

const HEALTHY: ProbeOutcome = { status: HealthStatus.Healthy };

/** How bad each status is: the report's status is its worst component's. */
const SEVERITY: Readonly<Record<HealthStatus, number>> = {
  [HealthStatus.Healthy]: 0,
  [HealthStatus.Degraded]: 1,
  [HealthStatus.Unhealthy]: 2,
};

const worstOf = (components: readonly HealthComponentReport[]): HealthStatus =>
  components.reduce<HealthStatus>(
    (worst, { status }) => (SEVERITY[status] > SEVERITY[worst] ? status : worst),
    HealthStatus.Healthy,
  );

export const healthReportOf = (components: readonly HealthComponentReport[]): HealthReport => ({
  status: worstOf(components),
  components,
});

/** The instance itself: `Unhealthy` from `app.close()` on. */
const applicationOutcome = (sources: HealthSources): ProbeOutcome =>
  sources.isStopping() ? { status: HealthStatus.Unhealthy, reason: "stopping" } : HEALTHY;

/** The recovery loop: stopped with the instance, or stuck when its last sweep is too old. */
function recoveryLoopOutcome(sources: HealthSources): ProbeOutcome {
  const { sweep, infrastructure } = sources;
  if (sweep.isStopped()) return { status: HealthStatus.Unhealthy, reason: "stopped" };
  const since = infrastructure.clock.now().getTime() - sweep.lastSweptAt().getTime();
  if (since <= STUCK_AFTER) return HEALTHY;
  return {
    status: HealthStatus.Unhealthy,
    reason: `stuck: its last sweep ended ${String(since / 1000)} s ago (more than ${String(STUCK_AFTER / 1000)} s)`,
  };
}

/** Liveness's components: no I/O, so each takes no time. */
const livenessComponents = (sources: HealthSources): HealthComponentReport[] => [
  componentReportOf(
    { name: sources.application, kind: HealthComponentKind.Application },
    applicationOutcome(sources),
    waitOf(0),
  ),
  componentReportOf(
    { name: "recovery-loop", kind: HealthComponentKind.RecoveryLoop },
    recoveryLoopOutcome(sources),
    waitOf(0),
  ),
];

export function applicationHealthOf(sources: HealthSources): ApplicationHealth {
  return {
    checkLiveness: () => Promise.resolve(healthReportOf(livenessComponents(sources))),
    checkReadiness: async () => {
      const live = livenessComponents(sources);
      const reached = await Promise.all(readinessProbes(sources));
      return healthReportOf([...live, ...reached]);
    },
  };
}
