/** Where a call's cost comes from. */
export enum CostSource {
  /** Reported by the provider: exact. */
  Api = "api",
  /** Tokens × the model's configured price. */
  PriceTable = "price-table",
  /** Reported by a paid tool (or a service step) itself. */
  Tool = "tool",
  /**
   * Not known (#853): a pass of a step that lost its lease before the step ended — a crash, a frozen
   * instance — whose recovery ran the step again. Its calls may have been sent and billed, or not:
   * the record has no amount (`costUsd` 0) and counts nothing against a budget; reports count it
   * apart (`CostReport.unknownCalls`).
   */
  Unknown = "unknown",
}
