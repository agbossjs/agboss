import { ConfigError } from "../core/error-families/config-errors.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";

/** The origin a listener's peers sign for, from its `publicUrl` (#1319, #1320). */

/** The origin of `publicUrl`: an absolute http(s) URL, else the listener is not made (or, for a function, the request fails). */
function originOf(publicUrl: string): string {
  try {
    const url = new URL(publicUrl);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // reported below, without the value
  }
  throw new ConfigError.Environment({
    message: "[mcp.public-url-invalid] mcpHttpListener's publicUrl is not an absolute http(s) URL",
  });
}

/** The origin source of a listener: checked now for a text, when asked for a function; required under a mesh with peers. */
export function originFn(
  app: object,
  publicUrl: string | (() => string) | undefined,
): () => string | undefined {
  if (typeof publicUrl === "string") {
    const origin = originOf(publicUrl);
    return () => origin;
  }
  if (publicUrl !== undefined) return () => originOf(publicUrl());
  const mesh = meshSettingsOf(app);
  if (mesh !== undefined && mesh.peers.size > 0)
    throw new ConfigError.Environment({
      message:
        "[mcp.public-url-invalid] mcpHttpListener's publicUrl is required under a @Mesh with peers",
    });
  return () => undefined;
}
