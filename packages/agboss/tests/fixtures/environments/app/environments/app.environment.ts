import type { Secret } from "../../../../../src/index.js";

/** The fixture application's environment contract (#261): declared fields only. */
export class SettingsEnvironment {
  apiUrl!: string;
  apiToken!: Secret;
  currency!: string;
  timeoutSeconds!: number;
  debug!: boolean;
}

// What `agboss check` writes into `.agboss/types.d.ts` for `@Application({ environment })`
// (`interface Environment extends SettingsEnvironment {}`); the framework's fixtures outside the
// generated set declare its fields by hand.
declare module "../../../../../src/flow/generated-types.js" {
  interface Environment {
    readonly apiUrl: string;
    readonly apiToken: Secret;
    readonly currency: string;
    readonly timeoutSeconds: number;
    readonly debug: boolean;
  }
}
