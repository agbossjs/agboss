import { MESH_HEADER, TRACEPARENT } from "../mesh/mesh-envelope.js";
import { meshLimitErrorOf } from "../mesh/mesh-wire.js";
import type { OutboundMesh } from "../mesh/outbound-mesh.js";

/** The client's side of the mesh (#398): the headers it sends, the refusals it reads. */

const HTTP_CONFLICT = 409;

/** A `409` naming a mesh limit: the server refused the call chain, nothing ran. */
export async function meshRefusalOfResponse(response: Response): Promise<Error | undefined> {
  if (response.status !== HTTP_CONFLICT) return undefined;
  return meshLimitErrorOf(await response.json().catch(() => undefined));
}

/** The headers of a call made inside an execution: the envelope and `traceparent`; else none. */
export const meshHeadersOf = (mesh: OutboundMesh | undefined): Record<string, string> =>
  mesh === undefined ? {} : { [MESH_HEADER]: mesh.envelope, [TRACEPARENT]: mesh.traceparent };
