import type { CircuitState } from "../../models/circuit-breaker.js";

/**
 * A model provider's circuit breaker changed state (#1313, `onCircuitStateChange`): it opened after
 * failed calls, opened again after a failed probe, or closed after a probe that succeeded. An event of
 * the application, no execution's: an `@Observer({ workflows })` filter does not receive it.
 */
export interface CircuitStateChangeEvent {
  /** The `@ModelProvider`'s name. */
  readonly provider: string;
  readonly from: CircuitState;
  readonly to: CircuitState;
  /** When it changed, on the application's clock. */
  readonly at: Date;
}
