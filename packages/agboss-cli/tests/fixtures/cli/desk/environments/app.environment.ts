import type { Secret } from "../../../../../../agboss/src/index.js";

/** The desk's environment: the built-in model providers' key, never used (no step calls a model). */
export class DeskEnvironment {
  openRouterApiKey!: Secret;
}
