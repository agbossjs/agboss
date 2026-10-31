import { keyTextRuleOf } from "../core/errors.js";
import type { MeshRequestKey } from "../infrastructure/mesh-request.repository.js";
import type { InboundMesh } from "../mesh/inbound-mesh.js";
import type { MeshEnvelope } from "../mesh/mesh-envelope.js";
import { encodeRunReport } from "../mesh/mesh-report.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import { bodyHashOf } from "../mesh/outbound-mesh.js";
import type { A2AApp } from "./a2a-caller.js";
import type { A2AExecutionResponse } from "./types.js";

/**
 * What the listener does for a trusted request (#398 PR 2) — an authenticated peer whose envelope's
 * signature verified: the body must be the one the envelope signed (`bodyHash`), its idempotency key
 * deduplicates it, and its answer carries the run report this application signs.
 */

/** A trusted request: its peer, its envelope and the tenant it runs for. */
export interface TrustedRequest {
  readonly peer: string;
  readonly envelope: MeshEnvelope;
  readonly tenantId: string;
}

/** The trusted request of an admitted one; `undefined` when it is not trusted. */
export function trustedRequestOf(
  inbound: InboundMesh | undefined,
  envelope: MeshEnvelope | undefined,
  tenantId: string,
): TrustedRequest | undefined {
  const peer = inbound?.trusted?.origin.application;
  if (peer === undefined || envelope === undefined) return undefined;
  return { peer, envelope, tenantId };
}

/** Whether the body is the one the envelope signed (a trusted envelope binds it). */
export const isSignedBody = (trusted: TrustedRequest | undefined, text: string): boolean =>
  trusted === undefined || trusted.envelope.bodyHash === bodyHashOf(text);

/** The dedupe key of a trusted request. */
export const dedupeKeyOf = (trusted: TrustedRequest | undefined): MeshRequestKey | undefined =>
  // #568: a tenant id that is no key's text keys no answer — UTF-8 stores would merge it with
  // another tenant's (t\uD800 is t\uFFFD); its execution refuses it as any request's
  trusted === undefined || keyTextRuleOf(trusted.tenantId) !== undefined
    ? undefined
    : {
        tenantId: trusted.tenantId,
        peer: trusted.peer,
        idempotencyKey: trusted.envelope.origin.step.idempotencyKey,
      };

/** The answer with this application's signed run report (a trusted request, when it signs). */
export function withRunReport(
  app: A2AApp,
  trusted: TrustedRequest | undefined,
  result: A2AExecutionResponse,
): A2AExecutionResponse {
  const settings = meshSettingsOf(app);
  const key = settings?.keys.signingKey;
  const { bodyHash } = trusted?.envelope ?? {};
  if (key === undefined || settings === undefined || bodyHash === undefined) return result;
  if (result.executionId === undefined || result.spend === undefined) return result;
  const facts = {
    issuer: settings.application,
    executionId: result.executionId,
    spentUsd: Number(result.spend.total),
    bodyHash,
    issuedAt: settings.clock.now(),
  };
  return { ...result, report: encodeRunReport(facts, key) };
}
