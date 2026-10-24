import { AGBossError } from "../core/errors.js";

/** A builder used where the grammar does not allow it (only reachable from untyped code). */
export class FlowSyntaxError extends AGBossError {
  static override readonly code: string = "flow.syntax";
}
