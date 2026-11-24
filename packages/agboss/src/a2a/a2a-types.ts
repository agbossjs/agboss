import { FilePayloadSource, fileSourceOf, type FileDto } from "../dto/standard/file.js";
import type { A2ATaskState } from "../infrastructure/a2a-task.repository.js";
import { A2A_SKILLS_EXTENSION } from "./a2a-extension-uris.js";

/**
 * The A2A v1.0 messages as `@agboss/core/a2a` gives and takes them (#1320): AGBoss's own types,
 * discriminated by `kind`, with `Date` times — never the official SDK's generated protobuf shapes
 * (`$case` unions, empty strings for absent texts). The SDK is read and written only at the
 * client's boundary (`a2a-public-map.ts`).
 */

/** Plain JSON facts a part, message, artifact or task carries besides its content. */
export type A2AMetadata = Readonly<Record<string, unknown>>;

/** What every part has besides its content. */
export interface A2APartBase {
  readonly metadata?: A2AMetadata;
  /** The file's name, when the part is a file. */
  readonly filename?: string;
  /** The content's media type (`text/plain`, `application/json`, a file's). */
  readonly mediaType?: string;
}

/** A text. */
export interface A2ATextPart extends A2APartBase {
  readonly kind: "text";
  readonly text: string;
}

/** A JSON value. */
export interface A2ADataPart extends A2APartBase {
  readonly kind: "data";
  readonly data: unknown;
}

/** A file whose bytes are in the part. */
export interface A2ARawPart extends A2APartBase {
  readonly kind: "raw";
  readonly bytes: Uint8Array;
}

/** A file the part names by address. */
export interface A2AUrlPart extends A2APartBase {
  readonly kind: "url";
  readonly url: string;
}

/** One part of a message or an artifact. */
export type A2APart = A2ATextPart | A2ADataPart | A2ARawPart | A2AUrlPart;

/** The A2A wire's part of a file (#859, #1316). */
export const A2APart = {
  /**
   * The part of a file whose bytes are at hand (inline) or elsewhere (`url`), for `send([...])`;
   * `field` names the DTO field an AGBoss receiver puts it into.
   */
  fromFile(file: FileDto, field?: string): A2APart {
    const named = {
      ...(field === undefined ? {} : { metadata: { [A2A_SKILLS_EXTENSION]: { field } } }),
      ...(file.filename === undefined ? {} : { filename: file.filename }),
      mediaType: file.mediaType,
    };
    return fileSourceOf(file) === FilePayloadSource.Url
      ? { kind: "url", url: file.url ?? "", ...named }
      : { kind: "raw", bytes: Buffer.from(file.inline ?? "", "base64"), ...named };
  },
} as const;

/** Who sent a message. */
export enum A2ARole {
  /** The client. */
  User = "user",
  /** The agent. */
  Agent = "agent",
}

/** A message: a user's, or an agent's answer. */
export interface A2AMessage {
  readonly messageId: string;
  readonly contextId?: string;
  readonly taskId?: string;
  /** Absent when the peer sent none. */
  readonly role?: A2ARole;
  readonly parts: readonly A2APart[];
  readonly metadata?: A2AMetadata;
  readonly extensions: readonly string[];
  readonly referenceTaskIds: readonly string[];
}

/** What a task produced: its output as parts. */
export interface A2AArtifact {
  readonly artifactId: string;
  readonly name?: string;
  readonly description?: string;
  readonly parts: readonly A2APart[];
  readonly metadata?: A2AMetadata;
  readonly extensions: readonly string[];
}

/** Where a remote task is: its state, the agent's message with it and when it got there. */
export interface A2ATaskProgress {
  readonly state: A2ATaskState;
  readonly message?: A2AMessage;
  readonly timestamp?: Date;
}

/** A remote task as its agent reports it. */
export interface A2ATask {
  readonly id: string;
  readonly contextId: string;
  /** Absent when the peer sent none: such a task is not read. */
  readonly status?: A2ATaskProgress;
  readonly artifacts: readonly A2AArtifact[];
  readonly history: readonly A2AMessage[];
  readonly metadata?: A2AMetadata;
}

/** One skill of an agent's card. */
export interface A2AAgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples: readonly string[];
  readonly inputModes: readonly string[];
  readonly outputModes: readonly string[];
}

/** One way to reach an agent. */
export interface A2AAgentInterface {
  readonly url: string;
  /** `JSONRPC`, `HTTP+JSON`, … */
  readonly protocolBinding: string;
  readonly tenant?: string;
  readonly protocolVersion: string;
}

/** An extension an agent declares. */
export interface A2AAgentExtension {
  readonly uri: string;
  readonly description?: string;
  readonly required: boolean;
  readonly params?: A2AMetadata;
}

/** What an agent can do besides its skills. */
export interface A2AAgentCapabilities {
  readonly streaming?: boolean;
  readonly pushNotifications?: boolean;
  readonly extendedAgentCard?: boolean;
  readonly extensions: readonly A2AAgentExtension[];
}

/** An agent's card (`/.well-known/agent-card.json`). */
export interface A2AAgentCard {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly supportedInterfaces: readonly A2AAgentInterface[];
  readonly provider?: { readonly organization: string; readonly url: string };
  readonly documentationUrl?: string;
  readonly iconUrl?: string;
  readonly capabilities?: A2AAgentCapabilities;
  /** The card's security schemes and requirements, as it states them. */
  readonly securitySchemes: Readonly<Record<string, unknown>>;
  readonly securityRequirements: readonly unknown[];
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly A2AAgentSkill[];
}

/** A remote task's status changed. */
export interface A2AStatusUpdateEvent {
  readonly kind: "status-update";
  readonly taskId: string;
  readonly contextId: string;
  readonly status?: A2ATaskProgress;
  readonly metadata?: A2AMetadata;
}

/** A remote task's artifact grew. */
export interface A2AArtifactUpdateEvent {
  readonly kind: "artifact-update";
  readonly taskId: string;
  readonly contextId: string;
  readonly artifact?: A2AArtifact;
  readonly append: boolean;
  readonly lastChunk: boolean;
  readonly metadata?: A2AMetadata;
}

/** One event of a remote task while a call waits. */
export type A2AStreamEvent =
  | { readonly kind: "task"; readonly task: A2ATask }
  | { readonly kind: "message"; readonly message: A2AMessage }
  | A2AStatusUpdateEvent
  | A2AArtifactUpdateEvent;

/** What `send` / `reply` take: a text, or an object with at least one of text, data and files, or parts. */
export type A2AMessageInput =
  | string
  | {
      readonly text: string;
      readonly data?: unknown;
      readonly files?: readonly FileDto[];
    }
  | {
      readonly data: unknown;
      readonly text?: string;
      readonly files?: readonly FileDto[];
    }
  | {
      readonly files: readonly [FileDto, ...FileDto[]];
      readonly text?: string;
      readonly data?: unknown;
    }
  | readonly [A2APart, ...A2APart[]];
