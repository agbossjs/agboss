/** A workflow module that cannot be loaded: no file, or not exactly one exported @Workflow class. */
export class WorkflowLoadError extends Error {
  override name = "WorkflowLoadError";
}

/** An application module that cannot be loaded: no file, or not exactly one exported @Application class. */
export class ApplicationLoadError extends Error {
  override name = "ApplicationLoadError";
}
