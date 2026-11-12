import { AGBossError, type MessageErrorOptions } from "../core/errors.js";

/** A builder used where the grammar does not allow it (only reachable from untyped code). */
export class FlowSyntaxError extends AGBossError {
  static override readonly code = "flow.syntax" as const;
  declare readonly code: typeof FlowSyntaxError.code;

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}
