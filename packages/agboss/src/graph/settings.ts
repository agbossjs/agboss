import type { IncompatibleResumePolicy } from "../run/resume-guard.js";

/** Builds `WorkflowSettings`; each method sets one part, `build()` freezes them. */
export interface WorkflowSettingsBuilder {
  /**
   * Decides a resume of a run paused under another config hash (an earlier deployment): "resume"
   * continues it on the current graph, "reject" fails with `IncompatibleResumeError` (the default).
   */
  readonly onIncompatibleResume: (policy: IncompatibleResumePolicy) => WorkflowSettingsBuilder;
  readonly build: () => WorkflowSettings;
}

/**
 * A workflow's settings, returned by its `settings()`. Money limits are not among them: they are
 * the application's `@Budget`s (#261); steps are `@Workflow({ maxSteps })`; model providers are the
 * application's (`@Application({ providers })`, #266) — a workflow names models only.
 */
export class WorkflowSettings {
  private constructor(readonly onIncompatibleResume: IncompatibleResumePolicy | undefined) {}

  static builder(): WorkflowSettingsBuilder {
    let onIncompatibleResume: IncompatibleResumePolicy | undefined;
    const builder: WorkflowSettingsBuilder = {
      onIncompatibleResume: (policy) => {
        onIncompatibleResume = policy;
        return builder;
      },
      build: () => new WorkflowSettings(onIncompatibleResume),
    };
    return builder;
  }
}

/** What a `@Workflow` class may implement: `settings()` — resumes of runs paused under another config. */
export interface WorkflowDefinition {
  settings(): WorkflowSettings;
}

/** The settings of a workflow without `settings()`: incompatible resumes rejected. */
export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = WorkflowSettings.builder().build();
