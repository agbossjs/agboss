import { InjectionToken } from "../components/injection.js";
import type { NewThreadId } from "../terns/index.js";
import { InMemoryDatabase } from "./in-memory-database.js";

/**
 * What the built-in infrastructure defaults read from their application instance besides the
 * public `Clock` and `ApplicationContext` (internal, never exported): the new thread ids and the
 * memory the in-memory defaults keep their rows in. The app registers them in its container; tests
 * give deterministic ids and one database shared by the instances of a test
 * (`testWith(App, { instances: 2 })`).
 */

/** A new thread id (random unless a test makes them deterministic). */
export const NEW_THREAD_ID = new InjectionToken<NewThreadId | undefined>("NEW_THREAD_ID");

/** Where the in-memory defaults keep their rows: one per instance, one per test in tests. */
export const IN_MEMORY_DATABASE = new InjectionToken<InMemoryDatabase>("IN_MEMORY_DATABASE");

/** All of them, as the core values every container of an application has. */
export const INFRASTRUCTURE_TOKENS = [NEW_THREAD_ID, IN_MEMORY_DATABASE];
