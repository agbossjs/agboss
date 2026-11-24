/** Where an intent stands. */
export enum OutboundCallStatus {
  /**
   * Recorded, and sent or about to be — or answered with an error of unknown outcome (#657): what
   * happened is not known here, and the next call reconciles it.
   */
  Pending = "pending",
  /** The other system answered: its result is stored. */
  Completed = "completed",
  /**
   * The other system definitely did not carry it out (#657: an error `isDefiniteFailure` named):
   * the next call sends it again, the same key.
   */
  Failed = "failed",
}
