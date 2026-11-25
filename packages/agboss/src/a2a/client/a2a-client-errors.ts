/**
 * What an `A2AClient` call fails with (#809, design §4.2 "Outcomes"). Never a remote text: an
 * agent's error message, a status message or a response body may carry its internals or unmasked
 * personal data, so each error keeps the stable facts only — the agent, the operation, the JSON-RPC
 * or HTTP code, the task's ids and state, an AGBoss peer's error code — and a fixed text of them.
 */

/** A remote error code is shown only when it reads as one (`limit.hops`, `a2a.start-lost`). */
const CODE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/u;
const MAX_CODE_LENGTH = 100;

/** `code` when it is a stable error code, else `undefined` (never a free text from the wire). */
export const remoteCodeOf = (code: unknown): string | undefined =>
  typeof code === "string" && code.length <= MAX_CODE_LENGTH && CODE.test(code) ? code : undefined;

/** Why a remote call gave nothing the call can use. */
export enum A2ARemoteCallReason {
  /** A COMPLETED task with no part the output DTO can be read from. */
  NoOutput = "no-output",
  /** The agent answered a typed `execute` with a `Message` that holds no readable output. */
  NoTask = "no-task",
  /** A task or event the client cannot read: no status, an unknown state, another task's id. */
  MalformedAnswer = "malformed-answer",
}

/** The A2A operation a protocol error came from. */
export enum A2AClientOperation {
  AgentCard = "agent-card",
  SendMessage = "SendMessage",
  SendStreamingMessage = "SendStreamingMessage",
  GetTask = "GetTask",
  CancelTask = "CancelTask",
  SubscribeToTask = "SubscribeToTask",
}

/** Which part of the declared contract the agent's card breaks. */
export enum A2AContractRule {
  /** `[a2a.unknown-skill]`: the skill the client names is not in the card. */
  UnknownSkill = "a2a.unknown-skill",
  /** `[a2a.schema-mismatch]`: the skill's schemas do not accept the client's DTOs. */
  SchemaMismatch = "a2a.schema-mismatch",
  /** `[a2a.unknown-finish]` (#916): a finish the client names (`target.finishes`) is not the skill's. */
  UnknownFinish = "a2a.unknown-finish",
  /**
   * `[a2a.repeated-call]`: one step called the client twice with different messages under one name
   * — each call of a step is one outbound call, so the second would replay the first's answer.
   */
  RepeatedCall = "a2a.repeated-call",
}
