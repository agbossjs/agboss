import { InjectionToken } from "../components/injection.js";
import type { NewThreadId } from "../terns/index.js";

/**
 * What the built-in infrastructure defaults read from their application instance (internal, never
 * exported): the time for the ledger's day and the records, and the new thread ids. The app
 * registers both in its container; tests give a controllable clock and deterministic ids.
 */

/** The time of the application instance (`() => new Date()` unless a test controls it). */
export const INFRASTRUCTURE_CLOCK = new InjectionToken<() => Date>("INFRASTRUCTURE_CLOCK");

/** A new thread id (random unless a test makes them deterministic). */
export const NEW_THREAD_ID = new InjectionToken<NewThreadId | undefined>("NEW_THREAD_ID");

/** Both, as the core values every container of an application has. */
export const INFRASTRUCTURE_TOKENS = [INFRASTRUCTURE_CLOCK, NEW_THREAD_ID];
