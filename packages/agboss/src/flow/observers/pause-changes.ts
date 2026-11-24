/**
 * What `app.extendPause` and `app.reassignPause` tell of the pause they changed (#1307): where it
 * waits, never its id (the right to answer it) and never its ask or the assignee.
 */
export interface PauseChange {
  readonly tenantId: string;
  /** The root execution the pause belongs to. */
  readonly executionId: string;
  readonly threadId: string;
  /** The workflow whose step asked. */
  readonly workflow: string;
  /** The channel role asked; absent for a pause nobody is asked about (`PauseRespondent.Owner`). */
  readonly channel?: string;
}

/** An operator moved a pause's deadline later (`onPauseTimeoutChanged`): once, by the call that won. */
export interface PauseTimeoutChangedEvent extends PauseChange {
  readonly previousExpiresAt: Date;
  readonly expiresAt: Date;
}

/** An operator moved a pause to another addressee (`onPauseReassigned`): once, by the call that won. */
export interface PauseReassignedEvent extends PauseChange {
  /** The channel the pause was asked on before; absent for one nobody was asked about. */
  readonly previousChannel?: string;
  /** The deadline it keeps (the old pause's). */
  readonly expiresAt?: Date;
}
