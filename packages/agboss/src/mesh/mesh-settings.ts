import type { KeyObject } from "node:crypto";
import type { Class } from "../components/injection.js";
import type { ApplicationContext } from "../flow/context/application-context.js";
import type { ContractsSnapshot } from "../describe/contracts-types.js";
import type { Clock } from "../infrastructure/clock.js";
import type { MeshKeys } from "./mesh-keys.js";
import type { MeshRequestRepository } from "../infrastructure/mesh-request.repository.js";
import type { MeshInboundMode } from "./mesh.decorator.js";

/**
 * What the mesh needs of an application instance (#398, internal): its name — the `application`
 * of its hops —, its `maxMeshHops`, its keys, its `Clock` (an envelope's `issuedAt`, `expiresIn`)
 * and how long a trusted request's answer is kept. Remembered for the instance's app (what a
 * transport is built from) and for its `ApplicationContext` (what a call inside an execution reads
 * through its frame).
 */
export interface MeshSettings {
  readonly application: string;
  readonly maxMeshHops: number;
  readonly keys: MeshKeys;
  /** `@Mesh({ inboundMode })`: whether a request to an endpoint must be signed by a peer. */
  readonly inboundMode: MeshInboundMode;
  /** `@Mesh({ envelopeTtl })`, ms: the lifetime of what it signs and the longest it accepts. */
  readonly envelopeTtl: number;
  /** `@Mesh({ maxClockSkew })`, ms: how far a signature's date may be from this clock. */
  readonly maxClockSkew: number;
  /** The shared store of admitted requests: signed HTTP requests are admitted once (`jti`), answers kept. */
  readonly requests: () => MeshRequestRepository;
  /** Whether the application's tenant context is the base one (a `tenantId` and nothing else). */
  readonly isBaseTenantContext: boolean;
  /** `@Mesh({ peers })`: what each peer is allowed, by its application name. */
  readonly peers: ReadonlyMap<string, MeshPeerRules>;
  readonly clock: Clock;
  readonly idempotencyRetention: number;
  /**
   * How long a finished A2A task is kept (`@Application({ retention: { a2aTasks } })`, #807): what an
   * A2A listener deduplicates a `messageId` for, its card's mesh `idempotencyRetention` (#810).
   */
  readonly a2aTaskRetention: number;
  /** How long an A2A task's files are kept once it is over (`retention.a2aFiles`, #859). */
  readonly a2aFileRetention: number;
  /**
   * How long a direct A2A message's reply is kept (`retention.a2aMessages`, #860): what a listener
   * deduplicates a direct-reply skill's `messageId` for, its card's mesh `messageIdempotencyRetention`.
   */
  readonly a2aMessageRetention: number;
  /** The application's workflows (#859: where an exported start's finishes are). */
  readonly workflows: readonly Class[];
  /** `@Application({ exposes })` (#398 PR 3): the contracts a transport may serve. */
  readonly exposes: readonly Class[];
  /**
   * The application's declared contracts (#808: what `describe --json` lists — each exported
   * start's input and finishes, every DTO's JSON Schema), read on first use: an A2A listener's
   * Agent Card is written from them.
   */
  readonly contracts: () => Promise<ContractsSnapshot>;
}

/** What a verified peer may do here: the endpoints it may call and whether its tenant is trusted. */
export interface MeshPeerRules {
  /** The `@A2AExpose` / `@McpEndpoint` classes it may call; `undefined` → any. */
  readonly allowEndpoints: readonly Class[] | undefined;
  /** Whether its signed `tenantId` is the caller's tenant. */
  readonly propagateTenant: boolean;
}

/**
 * What an application signs with before it has started (#1320): its name, keys, clock and peers —
 * the part of its settings the container-startup handshakes of its MCP servers need.
 */
export type MeshSigner = Pick<
  MeshSettings,
  "application" | "keys" | "clock" | "envelopeTtl" | "peers"
>;

const signersByContext = new WeakMap<ApplicationContext, MeshSigner>();

/** Remembers the application's signer at the start of its instance, before its workflows connect. */
export function rememberContextMeshSigner(context: ApplicationContext, signer: MeshSigner): void {
  signersByContext.set(context, signer);
}

/** The signer of an application's context; `undefined` before it is remembered. */
export const contextMeshSignerOf = (context: ApplicationContext): MeshSigner | undefined =>
  signersByContext.get(context);

const byApp = new WeakMap<object, () => MeshSettings | undefined>();
const byContext = new WeakMap<ApplicationContext, MeshSettings>();

/** Remembers an application instance's mesh settings (read when a request comes in). */
export function rememberMeshSettings(app: object, read: () => MeshSettings | undefined): void {
  byApp.set(app, read);
}

/** Remembers them for the instance's `ApplicationContext`: its executions' calls sign with them. */
export function rememberContextMeshSettings(
  context: ApplicationContext,
  settings: MeshSettings,
): void {
  byContext.set(context, settings);
}

/** The settings of an app an application instance made; `undefined` for a host's own `A2AApp`. */
export const meshSettingsOf = (app: object): MeshSettings | undefined => byApp.get(app)?.();

/** The settings of the application an execution runs in (its frame's `tenant.application`). */
export const contextMeshSettingsOf = (context: ApplicationContext): MeshSettings | undefined =>
  byContext.get(context);

/** The private key the application signs with; `undefined` when it signs nothing. */
export const signingKeyOf = (settings: MeshSettings | undefined): KeyObject | undefined =>
  settings?.keys.signingKey;
