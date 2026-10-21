import type { Secret } from "../../../../../../agboss/src/index.js";

/** The built-in model providers' key: Studio builds the graphs on it, no test calls a model. */
export class StudioEnvironment {
  openRouterApiKey!: Secret;
}
