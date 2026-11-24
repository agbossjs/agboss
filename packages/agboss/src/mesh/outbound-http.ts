import { currentFrame, type Frame } from "../flow/context/frame.js";
import { signMeshHttp } from "./mesh-http.js";
import type { ApplicationContext } from "../flow/context/application-context.js";
import { contextMeshSettingsOf, contextMeshSignerOf, type MeshSigner } from "./mesh-settings.js";

/** One request an AGBoss client is about to send: what its `X-AGBoss-Mesh` header is made for. */
export interface OutboundHttpRequest {
  readonly url: string;
  readonly method: string;
  /** The body as sent; none for a `GET`. Anything but text or bytes cannot be signed. */
  readonly body: unknown;
}

/**
 * The `X-AGBoss-Mesh` header of a request made by a client of the running execution's application
 * (#1320), addressed to `audience` (the receiver's `@Application({ name })`): signed with the
 * application's `@Mesh({ signingKey })`, carrying the execution's `tenantId` only when the
 * receiver is a peer with `propagateTenant`. `undefined` — nothing signed, the receiver judges the
 * request unsigned — for a request with no audience, no execution, no signing key, or a body that is
 * neither text nor bytes.
 */
export function meshHttpHeaderOf(
  audience: string | undefined,
  request: OutboundHttpRequest,
  application?: ApplicationContext,
): string | undefined {
  const running = runningFrame();
  const context = running?.execution.tenant.application ?? application;
  const bytes = signableBodyOf(request.body);
  const signer = context === undefined ? undefined : signerOf(context);
  if (audience === undefined || signer === undefined || bytes === undefined) return undefined;
  // a handshake or a call outside an execution has no tenant to propagate
  const propagate = signer.peers.get(audience)?.propagateTenant === true;
  return signMeshHttp(signer, {
    audience,
    method: request.method,
    url: request.url,
    body: bytes,
    tenantId: propagate ? running?.execution.tenant.tenantId : undefined,
  });
}

const runningFrame = (): Frame | undefined => {
  const frame = currentFrame();
  return frame === undefined || frame.isClosed() ? undefined : frame;
};

/** What the application signs with: its settings once started, else the signer read at its start. */
const signerOf = (context: ApplicationContext): MeshSigner | undefined =>
  contextMeshSettingsOf(context) ?? contextMeshSignerOf(context);

/** The body as text or bytes (none → empty); `undefined` for a stream or a form, which cannot be hashed up front. */
function signableBodyOf(body: unknown): string | Uint8Array | undefined {
  if (body === undefined) return "";
  return typeof body === "string" || body instanceof Uint8Array ? body : undefined;
}
