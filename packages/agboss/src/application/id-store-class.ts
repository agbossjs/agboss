import type { Class, Provider } from "../components/injection.js";
import { EXECUTION_ID_STORE } from "../infrastructure/execution-id-store.js";

/** The class bound with `provide(EXECUTION_ID_STORE, Class)`, when the providers have one. */
export function idStoreClassOf(providers: readonly Provider[]): Class | undefined {
  for (const listed of providers) {
    // a list may hold anything at run time: only a class provider of the token counts
    const provider: unknown = listed;
    if (typeof provider !== "object" || provider === null) continue;
    if ("provide" in provider && provider.provide === EXECUTION_ID_STORE && "useClass" in provider)
      return provider.useClass as Class;
  }
  return undefined;
}
