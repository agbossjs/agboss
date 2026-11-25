import { ExecutionError } from "../core/error-families/run-errors.js";

/**
 * Resume across deployments: a paused run remembers the workflow version and config hash it paused
 * under; `app.resume` compares them with the running app and, when they differ, asks the workflow's
 * `onIncompatibleResume` policy (`WorkflowSettings.builder().onIncompatibleResume(…)`) — no policy
 * means the resume is rejected with `ExecutionError.IncompatibleResume`.
 */

/** The workflow version (`@Workflow({ version })`) and config hash (`executionVersions`) of an app. */
export interface ResumeVersions {
  readonly workflowVersion: string;
  readonly configHash: string;
}

/** A resume of a run paused under other versions than the app that resumes it. */
export interface IncompatibleResume {
  readonly threadId: string;
  readonly executionId: string;
  /** What the run paused under. */
  readonly paused: ResumeVersions;
  /** What the resuming app runs. */
  readonly current: ResumeVersions;
}

/** What an `onIncompatibleResume` policy decides (#1324). */
export enum ResumeDecision {
  /** Continue the paused checkpoint on the current graph. */
  Resume = "resume",
  /** Fail the resume with `ExecutionError.IncompatibleResume`. */
  Reject = "reject",
}

/** Decides an incompatible resume, e.g. `({ paused }) => paused.workflowVersion === "1.1.0" ? ResumeDecision.Resume : ResumeDecision.Reject`. */
export type IncompatibleResumePolicy = (resume: IncompatibleResume) => ResumeDecision;

/** Throws `ExecutionError.IncompatibleResume` unless the config hashes match or the policy says "resume". */
export function checkResume(
  resume: IncompatibleResume,
  policy: IncompatibleResumePolicy | undefined,
): void {
  if (resume.paused.configHash === resume.current.configHash) return;
  if (policy?.(resume) === ResumeDecision.Resume) return;
  throw new ExecutionError.IncompatibleResume(resume);
}
