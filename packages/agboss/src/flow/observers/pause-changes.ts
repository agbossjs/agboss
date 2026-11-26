/**
 * What `app.setPauseTimeout` and `app.reassignPause` tell of the pause they changed (#1307): where it
 * waits, never its id (the right to answer it) and never its ask or the assignee.
 */
export interface PauseChange {
  readonly tenantId: string;
  /** The root execution the pause belongs to. */
  readonly executionId: string;
  readonly threadId: string;
  /** The workflow whose step asked. */
  readonly workflow: string;
  /** The pause target it waits under. */
  readonly target: string;
  /** The channel asked; absent for a pause nobody is asked about (`PauseRespondent.Owner`). */
  readonly channel?: string;
}

/** An operator changed a pause's deadline (`onPauseTimeoutChanged`): once, by the call that won. */
export interface PauseTimeoutChangedEvent extends PauseChange {
  /** The deadline it had; absent: none. */
  readonly previousExpiresAt?: Date;
  /** The deadline it has now; absent: none (`Timeout.None`). */
  readonly expiresAt?: Date;
}

/** An operator moved a pause to another addressee (`onPauseReassigned`): once, by the call that won. */
export interface PauseReassignedEvent extends PauseChange {
  /** The target the pause waited under before (`target` is where it waits now). */
  readonly previousTarget: string;
  /** The channel the pause was asked on before; absent for one nobody was asked about. */
  readonly previousChannel?: string;
  /** The deadline it has now: its old one, unless the reassignment set another. */
  readonly expiresAt?: Date;
}
