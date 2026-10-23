import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MeshRequestRepository,
  type MeshRequestKey,
} from "../infrastructure/mesh-request.repository.js";
import { MESH_REFUSAL_TEXT, MeshRefusalCode } from "../mesh/mesh-verification.js";
import type { A2AApp } from "./a2a-caller.js";
import { writeRejection } from "./a2a-caller-gate.js";
import { sendAnswer } from "./a2a-exchange.js";
import type { A2AExecutionResponse } from "./types.js";

/**
 * A trusted request's idempotency (#398 PR 2, Security 7): `POST <base>/execute` of an
 * authenticated peer, its envelope verified, is kept by `(tenant, peer, origin.step.idempotencyKey)`
 * in the application's `MeshRequestRepository`. A repeat gets the same answer without running
 * again — only the same peer and tenant find it —, a repeat while the first still runs a `409`
 * `mesh.request-in-progress`; a run that did not answer (its process died, it threw) is forgotten,
 * so the caller may try again. Untrusted requests are never deduplicated.
 */

const HTTP_CONFLICT = 409;

/** The answer kept for a key, and how to keep this request's. */
export interface Dedupe {
  /** `true` when the request was answered here (a repeat): nothing more to do. */
  readonly isAnswered: boolean;
  /** Keeps the answer sent (or forgets the request when there is none). */
  readonly keep: (result: A2AExecutionResponse | undefined) => Promise<void>;
}

const NO_DEDUPE: Dedupe = { isAnswered: false, keep: () => Promise.resolve() };

/** Admits a trusted request by its key: a repeat answered, a new one saved. */
export async function dedupeOf(
  app: A2AApp,
  key: MeshRequestKey | undefined,
  exchange: { readonly req: IncomingMessage; readonly res: ServerResponse },
  now: Date,
): Promise<Dedupe> {
  if (key === undefined) return NO_DEDUPE;
  const requests = app.resolve(MeshRequestRepository);
  const saved = await requests.saveIfAbsent({ ...key, createdAt: now.toISOString() });
  if (!saved) {
    const kept = await requests.findByKey(key);
    if (kept?.response !== undefined) sendAnswer(exchange.req, exchange.res, kept.response);
    else {
      const code = MeshRefusalCode.RequestInProgress;
      writeRejection(exchange.res, HTTP_CONFLICT, { code, error: MESH_REFUSAL_TEXT[code] });
    }
    return { isAnswered: true, keep: () => Promise.resolve() };
  }
  return {
    isAnswered: false,
    keep: (result) =>
      result === undefined ? requests.deleteByKey(key) : requests.saveResponse(key, result),
  };
}
