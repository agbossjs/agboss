import type { Secret } from "../../../../../../agboss/src/index.js";

/** The environment of a run against a local model server: the key and the server's address. */
export class StreamEnvironment {
  openRouterApiKey!: Secret;
  openRouterBaseUrl?: string;
}
