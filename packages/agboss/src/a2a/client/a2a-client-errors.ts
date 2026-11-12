import { AGBossError } from "../../core/errors.js";

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

/** What a remote call that answered with nothing usable knows. */
export interface A2ARemoteCallErrorOptions {
  /** The `@A2AAgent`'s name (or the client's class). */
  readonly agent: string;
  readonly reason: A2ARemoteCallReason;
  /** The task, when the agent made one. */
  readonly taskId?: string | undefined;
}

/**
 * The remote agent answered, but not with what the call needs (#809, was `A2ARemoteError`): a
 * COMPLETED task without a readable output, a typed call answered by a message without one, a task
 * the client cannot read. Its output, when there was one, was not used.
 */
export class A2ARemoteCallError extends AGBossError {
  static override readonly code = "a2a.remote" as const;
  override name = "A2ARemoteCallError";
  readonly agent: string;
  readonly reason: A2ARemoteCallReason;
  readonly taskId: string | undefined;

  constructor(options: A2ARemoteCallErrorOptions) {
    const task = options.taskId === undefined ? "" : ` (task ${options.taskId})`;
    super(`A2A agent ${options.agent} gave no usable answer${task}: ${options.reason}`, {
      details: { agent: options.agent, reason: options.reason },
    });
    this.agent = options.agent;
    this.reason = options.reason;
    this.taskId = options.taskId;
  }
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

/** What a protocol error knows: never the remote's message, body or data. */
export interface A2AProtocolErrorOptions {
  readonly agent: string;
  readonly operation: A2AClientOperation;
  /** The A2A error code the agent answered (`-32602`, `-32001`, …; an HTTP+JSON error's by its kind). */
  readonly rpcCode?: number | undefined;
  /** The HTTP status of a response that was no A2A error answer. */
  readonly httpStatus?: number | undefined;
  /** The A2A versions the agent's card declares, when none is one this client speaks. */
  readonly protocolVersions?: readonly string[];
}

/** At most this many versions of a card are named. */
const MAX_VERSIONS = 5;

/** The versions a card declares that read as versions (`0.3`, `0.3.0`): never a free text. */
const versionsShownOf = (versions: readonly string[]): readonly string[] =>
  versions.filter((version) => /^\d{1,3}(\.\d{1,3}){0,2}$/u.test(version)).slice(0, MAX_VERSIONS);

const describedOf = (options: A2AProtocolErrorOptions): string => {
  if (options.protocolVersions !== undefined) {
    const shown = versionsShownOf(options.protocolVersions);
    const versions = shown.length === 0 ? "none" : shown.join(", ");
    return `its Agent Card declares A2A ${versions} — this client speaks A2A 1.0 only (a v0.3 agent is not supported in 0.1.1)`;
  }
  if (options.rpcCode !== undefined) return `JSON-RPC error ${String(options.rpcCode)}`;
  if (options.httpStatus !== undefined) return `HTTP ${String(options.httpStatus)}`;
  return "an answer that is no A2A response";
};

/**
 * The agent answered an A2A operation with an error, or not as A2A v1.0 (#809): a JSON-RPC error
 * (`rpcCode`), an HTTP error that is no JSON-RPC answer (`httpStatus`), an Agent Card without a
 * v1.0 interface (`protocolVersions` — a v0.3-only agent names its version here). Only the codes:
 * the agent's own message is never kept.
 */
export class A2AProtocolError extends AGBossError {
  static override readonly code = "a2a.protocol" as const;
  override name = "A2AProtocolError";
  readonly agent: string;
  readonly operation: A2AClientOperation;
  readonly rpcCode: number | undefined;
  readonly httpStatus: number | undefined;
  readonly protocolVersions: readonly string[] | undefined;

  constructor(options: A2AProtocolErrorOptions, cause?: unknown) {
    super(`A2A agent ${options.agent} answered ${options.operation} with ${describedOf(options)}`, {
      ...(cause === undefined ? {} : { cause }),
      details: {
        agent: options.agent,
        operation: options.operation,
        ...(options.rpcCode === undefined ? {} : { rpcCode: options.rpcCode }),
        ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
      },
    });
    this.agent = options.agent;
    this.operation = options.operation;
    this.rpcCode = options.rpcCode;
    this.httpStatus = options.httpStatus;
    this.protocolVersions =
      options.protocolVersions === undefined
        ? undefined
        : versionsShownOf(options.protocolVersions);
  }
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

/** What a contract error knows: the agent, the rule, the skill and the differences found. */
export interface A2AContractErrorOptions {
  readonly agent: string;
  readonly rule: A2AContractRule;
  readonly skill: string;
  /** `input: currency: …`, `output (refund-finish): amount: …` — the schemas' differences. */
  readonly differences?: readonly string[];
}

/**
 * The agent's Agent Card does not serve what the client declares (#809, design §4.2), found before
 * anything is sent: the skill is unknown (`[a2a.unknown-skill]`), or the skill's input does not
 * accept the client's input DTO or one of its finish outputs — every one, or those
 * `target.finishes` names (#916) — is not accepted by the client's output DTO
 * (`[a2a.schema-mismatch]`, compared structurally as `check --federation` does), or a finish it
 * names is not the skill's (`[a2a.unknown-finish]`).
 */
export class A2AContractError extends AGBossError {
  static override readonly code = "a2a.contract" as const;
  override name = "A2AContractError";
  readonly agent: string;
  readonly rule: A2AContractRule;
  readonly skill: string;
  readonly differences: readonly string[];

  constructor(options: A2AContractErrorOptions) {
    const differences = options.differences ?? [];
    const listed = differences.length === 0 ? "" : `: ${differences.join("; ")}`;
    const what = {
      [A2AContractRule.UnknownSkill]: `its Agent Card has no skill "${options.skill}"`,
      [A2AContractRule.SchemaMismatch]: `the schemas of its skill "${options.skill}" do not match the client's DTOs`,
      [A2AContractRule.UnknownFinish]: `its skill "${options.skill}" has no finish the client names`,
      [A2AContractRule.RepeatedCall]:
        "this step already called it with another message — give each call of one step its own key ({ key })",
    }[options.rule];
    super(`[${options.rule}] A2A agent ${options.agent}: ${what}${listed} — nothing was sent`, {
      details: { agent: options.agent, rule: options.rule, skill: options.skill },
    });
    this.agent = options.agent;
    this.rule = options.rule;
    this.skill = options.skill;
    this.differences = differences;
  }
}
