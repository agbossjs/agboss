import type { KeyObject } from "node:crypto";
import type { Class } from "../components/injection.js";
import type { ApplicationContext } from "../flow/context/application-context.js";
import type { ContractsSnapshot } from "../describe/contracts-types.js";
import type { Clock } from "../infrastructure/clock.js";
import type { MeshKeys } from "./mesh-keys.js";
import type { A2AFileOptions } from "../a2a/files/a2a-file-options.js";

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
  readonly clock: Clock;
  readonly idempotencyRetention: number;
  /**
   * How long a finished A2A task is kept (`@Application({ retention: { a2aTasks } })`, #807): what an
   * A2A listener deduplicates a `messageId` for, its card's mesh `idempotencyRetention` (#810).
   */
  readonly a2aTaskRetention: number;
  /** How long an A2A task's files are kept once it is over (`retention.a2aFiles`, #859). */
  readonly a2aFileRetention: number;
  /** `@Application({ a2aFiles })` (#859): what the A2A skills take as files, and steps save. */
  readonly a2aFiles: A2AFileOptions | undefined;
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
