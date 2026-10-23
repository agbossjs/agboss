/**
 * What a remote call made inside a tool call reads and reports through its frame (#398 PR 2,
 * internal): the tool's name (the envelope's `origin.step.tool`), what the execution may still
 * spend and until when the call may take (the claims the envelope makes), and the remote execution
 * a trusted peer reported (`ToolCallRecord.remote`).
 */
export interface MeshCallServices {
  /** The tool making the call. */
  readonly tool: string;
  /** What the execution may still spend, in USD; `undefined` without budgets. */
  readonly remainingBudget: () => number | undefined;
  /** When the call must end: its tool's `timeout`, or the execution's deadline when sooner. */
  readonly deadlineAt: Date;
  /** Keeps the remote execution of the call, as its trusted peer reported it. */
  readonly recordRemote: (remote: ToolCallRemote) => void;
}

/**
 * The remote execution a tool call ran (#398 PR 2, C8): the peer's application and its execution's
 * id, from the run report the peer signed — set only when it verified.
 */
export interface ToolCallRemote {
  readonly application: string;
  readonly executionId: string;
}
