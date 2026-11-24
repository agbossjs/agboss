/** Who may answer a pause of a target: required on every one, no default. */
export enum PauseRespondent {
  /** The thread's owner (`resume` checks its `ownerId`): a workflow question to the customer. */
  Owner = "owner",
  /** The channel's side authenticates who answers (Slack, a ticket system, an automation). */
  Delegate = "delegate",
}
