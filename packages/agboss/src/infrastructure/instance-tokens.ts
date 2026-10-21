import { InjectionToken } from "../components/injection.js";
import { InMemoryDatabase } from "./in-memory-database.js";

/**
 * What the built-in infrastructure defaults read from their application instance besides the
 * public `Clock`, `IdGenerator` and `ApplicationContext` (internal, never exported): the memory the
 * in-memory defaults keep their rows in. The app registers it in its container; tests give one
 * database shared by the instances of a test (`testWith(App, { instances: 2 })`).
 */

/** Where the in-memory defaults keep their rows: one per instance, one per test in tests. */
export const IN_MEMORY_DATABASE = new InjectionToken<InMemoryDatabase>("IN_MEMORY_DATABASE");

/** All of them, as the core values every container of an application has. */
export const INFRASTRUCTURE_TOKENS = [IN_MEMORY_DATABASE];
