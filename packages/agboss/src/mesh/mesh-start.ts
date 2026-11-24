import type { App } from "../app/types.js";
import { rememberA2AClientServicesOf } from "../a2a/client/a2a-client-services.js";
import type { AssembledApplication } from "../application/assemble.js";
import { MeshRequestRepository } from "../infrastructure/mesh-request.repository.js";
import { TenantContext } from "../flow/context/tenant-context.js";
import { ApplicationContext } from "../flow/context/application-context.js";
import { Clock, lazyLoad } from "../infrastructure/clock.js";
import { meshKeysOf } from "./mesh-keys.js";
import { CLOCK_SKEW, ENVELOPE_LIFETIME } from "./mesh-defaults.js";
import { MeshInboundMode } from "./mesh.decorator.js";
import {
  rememberContextMeshSettings,
  rememberContextMeshSigner,
  type MeshSettings,
  type MeshSigner,
} from "./mesh-settings.js";

/**
 * What an application instance signs with, read at the start of the instance (#1320): its keys —
 * a key that is no Ed25519 key fails the start — its clock and its peers' rules.
 */
export function meshSignerOf(
  assembled: AssembledApplication,
  clock: Clock,
  processEnv: NodeJS.ProcessEnv,
): MeshSigner {
  return {
    application: assembled.name,
    keys: meshKeysOf(assembled.mesh, processEnv),
    clock,
    envelopeTtl: assembled.mesh?.envelopeTtl ?? ENVELOPE_LIFETIME,
    peers: peerRulesOf(assembled.mesh),
  };
}

/**
 * Reads the instance's mesh keys before its workflows connect (#1320): an MCP server's handshake is
 * signed with them, and a key that is no Ed25519 key fails the start here.
 */
export function startMeshSigner(
  assembled: AssembledApplication,
  application: ApplicationContext | undefined,
  parts: { readonly clock: Clock; readonly processEnv: NodeJS.ProcessEnv },
): void {
  if (application === undefined) return;
  rememberContextMeshSigner(application, meshSignerOf(assembled, parts.clock, parts.processEnv));
}

/** What each peer of a `@Mesh` may do, by its application name. */
const peerRulesOf = (mesh: AssembledApplication["mesh"]): MeshSettings["peers"] =>
  new Map(
    (mesh?.peers ?? []).map((peer) => [
      peer.application,
      { allowEndpoints: peer.allowEndpoints, propagateTenant: peer.propagateTenant === true },
    ]),
  );

/**
 * An application instance's mesh settings at its start (#398): its keys read from the process environment
 * (a key that is no Ed25519 key fails the start), remembered for its `ApplicationContext` too.
 */
export function meshSettingsFor(
  assembled: AssembledApplication,
  app: Pick<App, "resolve">,
  processEnv: NodeJS.ProcessEnv,
): MeshSettings {
  const context = app.resolve(ApplicationContext);
  const clock = app.resolve(Clock);
  const signer = meshSignerOf(assembled, clock, processEnv);
  const settings: MeshSettings = {
    ...signer,
    maxMeshHops: assembled.maxMeshHops,
    inboundMode: assembled.mesh?.inboundMode ?? MeshInboundMode.AllowExternal,
    maxClockSkew: assembled.mesh?.maxClockSkew ?? CLOCK_SKEW,
    requests: () => app.resolve(MeshRequestRepository),
    isBaseTenantContext: assembled.tenantContext === TenantContext,
    idempotencyRetention: assembled.meshAnswerRetention,
    a2aTaskRetention: assembled.a2aTaskRetention,
    a2aFileRetention: assembled.a2aFileRetention,
    a2aMessageRetention: assembled.a2aMessageRetention,
    workflows: assembled.workflows.map((workflow) => workflow.graph.type),
    exposes: assembled.exposes,
    contracts: async () =>
      (await lazyLoad(import("../describe/contracts.js"))).contractsOf(assembled),
  };
  rememberContextMeshSettings(context, settings);
  // #809: the client side — what an A2A client's calls use (OutboundCalls, the Clock), by frame
  rememberA2AClientServicesOf(app);
  return settings;
}
