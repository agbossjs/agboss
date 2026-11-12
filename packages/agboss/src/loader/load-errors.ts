import { AGBossError, type MessageErrorOptions } from "../core/errors.js";

/** A workflow module that cannot be loaded: no file, or not exactly one exported @Workflow class. */
export class WorkflowLoadError extends AGBossError {
  static override readonly code = "load.workflow" as const;
  declare readonly code: typeof WorkflowLoadError.code;
  override name = "WorkflowLoadError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

/** An application module that cannot be loaded: no file, or not exactly one exported @Application class. */
export class ApplicationLoadError extends AGBossError {
  static override readonly code = "load.application" as const;
  declare readonly code: typeof ApplicationLoadError.code;
  override name = "ApplicationLoadError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}
