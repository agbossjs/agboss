import { z } from "zod";
import type { Usd } from "../units/index.js";
import type { IncompatibleResumePolicy } from "../run/resume-guard.js";

/** Limits of one run: its spend (steps are `@Workflow({ maxSteps })`, #272). */
export interface PerRunLimits {
  readonly cost?: Usd;
}

/** Limits of one workflow per UTC day. */
export interface PerDayLimits {
  readonly cost?: Usd;
}

/** `.limits({ perRun: { cost: usd(0.5) }, perDay: { cost: usd(5) } })`. */
export interface WorkflowLimits {
  readonly perRun?: PerRunLimits;
  readonly perDay?: PerDayLimits;
}

const WorkflowLimitsSchema = z.object({
  perRun: z.strictObject({ cost: z.number().min(0).optional() }).optional(),
  perDay: z.object({ cost: z.number().min(0).optional() }).optional(),
});

export class WorkflowSettingsError extends Error {
  override name = "WorkflowSettingsError";
}

/** Builds `WorkflowSettings`; each method sets one part, `build()` checks and freezes them. */
export interface WorkflowSettingsBuilder {
  readonly limits: (limits: WorkflowLimits) => WorkflowSettingsBuilder;
  /**
   * Decides a resume of a run paused under another config hash (an earlier deployment): "resume"
   * continues it on the current graph, "reject" fails with `IncompatibleResumeError` (the default).
   */
  readonly onIncompatibleResume: (policy: IncompatibleResumePolicy) => WorkflowSettingsBuilder;
  readonly build: () => WorkflowSettings;
}

/**
 * A workflow's settings, returned by its `settings()`. Model providers are not among them: they are
 * the application's (`@Application({ providers })`, #266) — a workflow names models only.
 */
export class WorkflowSettings {
  private constructor(
    readonly limits: WorkflowLimits,
    readonly onIncompatibleResume: IncompatibleResumePolicy | undefined,
  ) {}

  static builder(): WorkflowSettingsBuilder {
    let limits: WorkflowLimits = {};
    let onIncompatibleResume: IncompatibleResumePolicy | undefined;
    const builder: WorkflowSettingsBuilder = {
      limits: (value) => {
        const parsed = WorkflowLimitsSchema.safeParse(value);
        if (!parsed.success) {
          throw new WorkflowSettingsError(`limits: ${z.prettifyError(parsed.error)}`);
        }
        limits = value;
        return builder;
      },
      onIncompatibleResume: (policy) => {
        onIncompatibleResume = policy;
        return builder;
      },
      build: () => new WorkflowSettings(Object.freeze({ ...limits }), onIncompatibleResume),
    };
    return builder;
  }
}

/** What a `@Workflow` class may implement: `settings()` — cost limits, resumes. */
export interface WorkflowDefinition {
  settings(): WorkflowSettings;
}

/** The settings of a workflow without `settings()`: no cost limits, incompatible resumes rejected. */
export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = WorkflowSettings.builder().build();
