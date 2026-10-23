import type { KeyObject } from "node:crypto";
import type { Class } from "../components/injection.js";
import type { ApplicationContext } from "../flow/context/application-context.js";
import type { Clock } from "../infrastructure/clock.js";
import type { MeshKeys } from "./mesh-keys.js";

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
  /** `@Application({ exposes })` (#398 PR 3): the contracts a transport may serve. */
  readonly exposes: readonly Class[];
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
