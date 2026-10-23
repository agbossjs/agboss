import { MESH_HEADER, TRACEPARENT } from "../mesh/mesh-envelope.js";
import { meshLimitErrorOf } from "../mesh/mesh-wire.js";
import type { OutboundMesh } from "../mesh/outbound-mesh.js";

/** The client's side of the mesh (#398): the headers it sends, the refusals it reads. */

const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;

/** A refused envelope's body (`401 { code: "mesh.…", error }`). */
const envelopeRefusalOf = (body: unknown): Error | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const code: unknown = Reflect.get(body, "code");
  const error: unknown = Reflect.get(body, "error");
  if (typeof code !== "string" || !code.startsWith("mesh.")) return undefined;
  return new Error(`[${code}] the server refused the mesh envelope: ${String(error)}`);
};

/**
 * A `409` naming a mesh limit — the server refused the call chain — or a `401` naming a refused
 * envelope (`mesh.signature-invalid`, `mesh.audience-mismatch`, …, #398 PR 3): nothing ran.
 */
export async function meshRefusalOfResponse(response: Response): Promise<Error | undefined> {
  if (response.status !== HTTP_CONFLICT && response.status !== HTTP_UNAUTHORIZED) return undefined;
  const body: unknown = await response.json().catch(() => undefined);
  return response.status === HTTP_CONFLICT ? meshLimitErrorOf(body) : envelopeRefusalOf(body);
}

/** The headers of a call made inside an execution: the envelope and `traceparent`; else none. */
export const meshHeadersOf = (mesh: OutboundMesh | undefined): Record<string, string> =>
  mesh === undefined ? {} : { [MESH_HEADER]: mesh.envelope, [TRACEPARENT]: mesh.traceparent };
