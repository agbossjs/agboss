/**
 * Resume across deployments: a paused run remembers the workflow version and config hash it paused
 * under; `app.resume` compares them with the running app and, when they differ, asks the workflow's
 * `onIncompatibleResume` policy (`WorkflowSettings.builder().onIncompatibleResume(…)`) — no policy
 * means the resume is rejected with `IncompatibleResumeError`.
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

/** "resume": continue the paused checkpoint on the current graph; "reject": fail the resume. */
export type ResumeDecision = "resume" | "reject";

/** Decides an incompatible resume, e.g. `({ paused }) => paused.workflowVersion === "1.1.0" ? "resume" : "reject"`. */
export type IncompatibleResumePolicy = (resume: IncompatibleResume) => ResumeDecision;

const shortHash = (hash: string): string => hash.slice(0, 12);

const label = ({ workflowVersion, configHash }: ResumeVersions): string =>
  `${workflowVersion} (config ${shortHash(configHash)})`;

/** A paused run cannot be resumed by this app: it paused under another workflow version or config. */
export class IncompatibleResumeError extends Error {
  override name = "IncompatibleResumeError";
  readonly code = "resume.incompatible";
  readonly threadId: string;
  readonly executionId: string;
  readonly paused: ResumeVersions;
  readonly current: ResumeVersions;

  constructor(resume: IncompatibleResume) {
    super(
      `[resume.incompatible] thread "${resume.threadId}" paused under ${label(resume.paused)}, ` +
        `this app runs ${label(resume.current)} — register ` +
        `WorkflowSettings.builder().onIncompatibleResume(…) to resume it anyway`,
    );
    this.threadId = resume.threadId;
    this.executionId = resume.executionId;
    this.paused = resume.paused;
    this.current = resume.current;
  }
}

/** Throws `IncompatibleResumeError` unless the config hashes match or the policy says "resume". */
export function checkResume(
  resume: IncompatibleResume,
  policy: IncompatibleResumePolicy | undefined,
): void {
  if (resume.paused.configHash === resume.current.configHash) return;
  if (policy?.(resume) === "resume") return;
  throw new IncompatibleResumeError(resume);
}
